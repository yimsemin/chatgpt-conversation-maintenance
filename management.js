import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { assert } from "./assert.js";
import { ACCOUNT_ID, CONVERSATION_ID } from "./ids.js";

const DECISIONS = new Set(["keep", "delete"]);
const ACTION_KEYS = new Set(["conversationId", "expectedTitle", "decision", "approved", "backupFile", "backupSha256", "newTitle"]);
const MANIFEST_KEYS = new Set(["version", "workspace", "receiptDir", "source", "actions"]);
const DIGEST = /^[0-9a-f]{64}$/;

function cleanTitle(value, field) {
  assert(typeof value === "string" && value.trim(), `${field} must be a non-empty string`);
  assert(value.length <= 512, `${field} must be at most 512 characters`);
  return value;
}

export function validateManagementManifest(input) {
  assert(input && typeof input === "object" && !Array.isArray(input), "Manifest must be a JSON object");
  for (const key of Object.keys(input)) assert(MANIFEST_KEYS.has(key), `Manifest contains unknown field: ${key}`);
  assert(input.version === 1, "Manifest version must be 1");
  assert(input.workspace === "business", "Manifest workspace must be \"business\"");
  assert(typeof input.receiptDir === "string" && input.receiptDir.trim(), "receiptDir is required");
  assert(isAbsolute(input.receiptDir), "receiptDir must be an absolute path");
  assert(Array.isArray(input.actions) && input.actions.length > 0, "Manifest must contain at least one action");
  assert(input.actions.length <= 25, "A single manifest may contain at most 25 actions");

  const seen = new Set();
  const actions = input.actions.map((raw, index) => {
    const label = `actions[${index}]`;
    assert(raw && typeof raw === "object" && !Array.isArray(raw), `${label} must be an object`);
    for (const key of Object.keys(raw)) assert(ACTION_KEYS.has(key), `${label} contains unknown field: ${key}`);
    assert(CONVERSATION_ID.test(raw.conversationId || ""), `${label}.conversationId is invalid`);
    assert(!seen.has(raw.conversationId), `${label}.conversationId is duplicated`);
    seen.add(raw.conversationId);
    assert(DECISIONS.has(raw.decision), `${label}.decision must be keep or delete`);
    assert(raw.approved === true, `${label}.approved must be true`);
    assert(typeof raw.backupFile === "string" && raw.backupFile.trim(), `${label}.backupFile is required`);
    assert(isAbsolute(raw.backupFile), `${label}.backupFile must be an absolute path`);
    if (raw.backupSha256 !== undefined) assert(DIGEST.test(raw.backupSha256), `${label}.backupSha256 is invalid`);

    const expectedTitle = cleanTitle(raw.expectedTitle, `${label}.expectedTitle`);
    const newTitle = raw.newTitle === undefined ? undefined : cleanTitle(raw.newTitle, `${label}.newTitle`);
    assert(!(raw.decision === "delete" && newTitle), `${label} cannot rename a conversation that will be deleted`);
    return {
      conversationId: raw.conversationId,
      expectedTitle,
      decision: raw.decision,
      approved: true,
      backupFile: resolve(raw.backupFile),
      ...(raw.backupSha256 ? { backupSha256: raw.backupSha256 } : {}),
      ...(newTitle ? { newTitle } : {}),
    };
  });

  let source;
  if (input.source !== undefined) {
    assert(input.source && typeof input.source === "object" && !Array.isArray(input.source), "source must be an object");
    const sourceKeys = Object.keys(input.source);
    assert(sourceKeys.length === 2 && sourceKeys.includes("inventoryDigest") && sourceKeys.includes("decisionsDigest"),
      "source must contain only inventoryDigest and decisionsDigest");
    assert(DIGEST.test(input.source.inventoryDigest || ""), "source.inventoryDigest is invalid");
    assert(DIGEST.test(input.source.decisionsDigest || ""), "source.decisionsDigest is invalid");
    source = {
      inventoryDigest: input.source.inventoryDigest,
      decisionsDigest: input.source.decisionsDigest,
    };
    assert(actions.every((action) => action.backupSha256), "Every source-bound action requires backupSha256");
  }

  return {
    version: 1,
    workspace: "business",
    receiptDir: resolve(input.receiptDir),
    ...(source ? { source } : {}),
    actions,
  };
}

export function inspectConversationBackup(action) {
  assert(existsSync(action.backupFile), `Backup not found: ${action.backupFile}`);
  const stat = statSync(action.backupFile);
  assert(stat.isFile(), `Backup is not a regular file: ${action.backupFile}`);
  assert(action.backupFile.toLowerCase().endsWith(".json"), `Backup must be a JSON file: ${action.backupFile}`);

  const raw = readFileSync(action.backupFile);
  let data;
  try { data = JSON.parse(raw.toString("utf8")); }
  catch { throw new Error(`Backup is not valid JSON: ${action.backupFile}`); }

  const backupId = data?.conversation_id || data?.id;
  assert(backupId === action.conversationId, `Backup conversation ID does not match ${action.conversationId}`);
  assert(data?.title === action.expectedTitle, `Backup title does not match ${action.conversationId}`);
  assert(data?.mapping && typeof data.mapping === "object" && Object.keys(data.mapping).length > 0,
    `Backup has no conversation mapping: ${action.conversationId}`);
  const backupSha256 = createHash("sha256").update(raw).digest("hex");
  if (action.backupSha256) {
    assert(backupSha256 === action.backupSha256, `Backup SHA-256 does not match ${action.conversationId}`);
  }

  return {
    path: action.backupFile,
    bytes: stat.size,
    sha256: backupSha256,
    createTime: data.create_time ?? null,
    updateTime: data.update_time ?? null,
  };
}

export function managementConfirmation(manifest) {
  const deletes = manifest.actions.filter((action) => action.decision === "delete").length;
  return `APPLY ${manifest.actions.length} ACTIONS; DELETE ${deletes} CONVERSATIONS; PLAN ${managementManifestDigest(manifest).slice(0, 12)}`;
}

export function managementManifestDigest(manifest) {
  const normalized = validateManagementManifest(manifest);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function prepareManagementWorkflow(rawManifest) {
  const manifest = validateManagementManifest(rawManifest);
  const manifestDigest = managementManifestDigest(manifest);
  return {
    ok: true,
    phase: "prepare",
    manifestDigest,
    expectedConfirmation: managementConfirmation(manifest),
    review: manifest.actions.map((action) => ({
      conversationId: action.conversationId,
      expectedTitle: action.expectedTitle,
      decision: action.decision,
      ...(action.newTitle ? { newTitle: action.newTitle } : {}),
      backup: inspectConversationBackup(action),
    })),
  };
}

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function remoteConversation(data, action) {
  const remoteId = data?.conversation_id || data?.id;
  assert(remoteId === action.conversationId, `Remote conversation ID does not match ${action.conversationId}`);
  assert(data?.title === action.expectedTitle, `Remote title does not match ${action.conversationId}`);
  return {
    title: data.title,
    isArchived: data.is_archived === true,
    isVisible: data.is_visible !== false,
  };
}

async function readRemote(api, action) {
  const response = await api.getConversation(action.conversationId);
  assert(response && typeof response === "object", `Invalid API response for ${action.conversationId}`);
  assert(response.ok, `Could not read ${action.conversationId}: HTTP ${response.status}`);
  return remoteConversation(response.data, action);
}

async function verifyRename(api, action) {
  const response = await api.getConversation(action.conversationId);
  assert(response.ok, `Could not verify renamed conversation ${action.conversationId}: HTTP ${response.status}`);
  const id = response.data?.conversation_id || response.data?.id;
  assert(id === action.conversationId, `Rename verification returned a different conversation ID`);
  assert(response.data?.title === action.newTitle, `Rename verification failed for ${action.conversationId}`);
}

async function verifyDelete(api, action) {
  const response = await api.getConversation(action.conversationId);
  if (!response.ok && (response.status === 404 || response.status === 410)) return "not-found";
  assert(response.ok, `Could not verify deleted conversation ${action.conversationId}: HTTP ${response.status}`);
  assert(response.data?.is_visible === false, `Delete verification failed for ${action.conversationId}`);
  return "not-visible";
}

function createReceiptFile(receiptDir, receipt) {
  mkdirSync(receiptDir, { recursive: true });
  const stamp = receipt.startedAt.replace(/[:.]/g, "-");
  const finalPath = join(receiptDir, `${stamp}_${receipt.runId}.json`);
  writeReceiptAtPath(finalPath, receipt);
  return finalPath;
}

function writeReceiptAtPath(finalPath, receipt) {
  const partialPath = `${finalPath}.partial-${randomUUID()}`;
  try {
    writeFileSync(partialPath, JSON.stringify(receipt, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(partialPath, finalPath);
  } catch (error) {
    try { unlinkSync(partialPath); } catch {}
    throw error;
  }
}

export async function runManagementWorkflow({ mode, manifest: rawManifest, accountId, confirmation, reviewedConversationIds, api, recheckBeforeEachWrite = true, actionConcurrency = 1, now = () => new Date() }) {
  assert(mode === "preflight" || mode === "apply", "Mode must be preflight or apply");
  assert(ACCOUNT_ID.test(accountId || ""), "A valid ChatGPT Business account ID is required");
  assert(api?.getConversation && api?.patchConversation, "Management API adapter is incomplete");
  assert(Number.isInteger(actionConcurrency) && actionConcurrency >= 1 && actionConcurrency <= 4,
    "Action concurrency must be an integer from 1 to 4");

  const manifest = validateManagementManifest(rawManifest);
  const manifestDigest = managementManifestDigest(manifest);
  const expectedConfirmation = managementConfirmation(manifest);
  // Strict runs verify the full remote batch before any write and then close the
  // time-of-check/time-of-use gap again per action. Efficient apply runs the
  // same remote check immediately before each write, avoiding a burst of reads.
  const batchRemotePreflight = mode === "preflight" || recheckBeforeEachWrite;
  const inspectAction = async (action) => {
    const item = {
      conversationId: action.conversationId,
      expectedTitle: action.expectedTitle,
      decision: action.decision,
      ...(action.newTitle ? { newTitle: action.newTitle } : {}),
    };
    try {
      item.backup = inspectConversationBackup(action);
      if (batchRemotePreflight) item.remote = await readRemote(api, action);
      item.ok = true;
    } catch (error) {
      item.ok = false;
      item.error = error.message;
    }
    return item;
  };
  const preflight = batchRemotePreflight
    ? await mapConcurrent(manifest.actions, 4, inspectAction)
    : await Promise.all(manifest.actions.map(inspectAction));
  const preflightFailed = preflight.some((item) => !item.ok);

  if (preflightFailed) {
    return { ok: false, phase: "preflight", manifestDigest, expectedConfirmation, preflight };
  }
  if (mode === "preflight") {
    return { ok: true, phase: "preflight", manifestDigest, expectedConfirmation, preflight };
  }

  assert(confirmation === expectedConfirmation, "Confirmation phrase does not match the manifest");
  const expectedReviewedIds = manifest.actions.map((action) => action.conversationId);
  assert(Array.isArray(reviewedConversationIds), "Every action must be reviewed by the user");
  assert(JSON.stringify(reviewedConversationIds) === JSON.stringify(expectedReviewedIds),
    "Reviewed conversation IDs do not exactly match the manifest");

  const receipt = {
    version: 1,
    runId: randomUUID(),
    workspace: manifest.workspace,
    ...(manifest.source ? { source: manifest.source } : {}),
    startedAt: now().toISOString(),
    status: "running",
    verificationProfile: recheckBeforeEachWrite ? "strict" : "efficient",
    actionConcurrency,
    manifestDigest,
    expectedConfirmation,
    reviewedConversationIds: expectedReviewedIds,
    results: [],
  };
  // Prove that the receipt directory is writable before the first mutation.
  const receiptFile = createReceiptFile(manifest.receiptDir, receipt);
  let failure = null;
  let nextActionIndex = 0;
  const startedIndexes = new Set();

  async function applyAction(action, index) {
    const checked = preflight[index];
    const result = {
      conversationId: action.conversationId,
      expectedTitle: action.expectedTitle,
      decision: action.decision,
      backup: checked.backup,
      startedAt: now().toISOString(),
      mutations: [],
    };
    receipt.currentActions ||= [];
    receipt.currentActions.push({
      conversationId: action.conversationId,
      decision: action.decision,
      startedAt: result.startedAt,
    });
    writeReceiptAtPath(receiptFile, receipt);
    try {
      // Strict mode repeats the completed batch check; efficient mode performs
      // its single remote preflight here. Both verify every mutation afterward.
      await readRemote(api, action);

      if (action.newTitle) {
        await api.patchConversation(action.conversationId, { title: action.newTitle });
        result.mutations.push({ type: "rename", title: action.newTitle });
        await verifyRename(api, action);
      }

      if (action.decision === "delete") {
        await api.patchConversation(action.conversationId, { is_visible: false });
        result.mutations.push({ type: "delete" });
        result.verification = await verifyDelete(api, action);
      } else {
        result.verification = action.newTitle ? "renamed" : "kept";
      }

      result.ok = true;
    } catch (error) {
      result.ok = false;
      result.error = error.message;
      failure ||= error;
    }
    result.finishedAt = now().toISOString();
    receipt.results.push(result);
    receipt.currentActions = receipt.currentActions.filter(
      (item) => item.conversationId !== action.conversationId
    );
    if (receipt.currentActions.length === 0) delete receipt.currentActions;
    writeReceiptAtPath(receiptFile, receipt);
  }

  async function actionWorker() {
    while (!failure && nextActionIndex < manifest.actions.length) {
      const index = nextActionIndex++;
      startedIndexes.add(index);
      await applyAction(manifest.actions[index], index);
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(actionConcurrency, manifest.actions.length) },
    () => actionWorker()
  ));

  if (failure && startedIndexes.size < manifest.actions.length) {
    for (const [index, action] of manifest.actions.entries()) {
      if (startedIndexes.has(index)) continue;
      receipt.results.push({
        conversationId: action.conversationId,
        expectedTitle: action.expectedTitle,
        decision: action.decision,
        ok: false,
        skipped: true,
        error: "Skipped because an earlier action failed",
      });
    }
  }

  receipt.status = failure ? "failed" : "completed";
  receipt.finishedAt = now().toISOString();
  writeReceiptAtPath(receiptFile, receipt);
  return {
    ok: !failure,
    phase: "apply",
    manifestDigest,
    expectedConfirmation,
    receiptFile,
    results: receipt.results,
    ...(failure ? { error: failure.message } : {}),
  };
}
