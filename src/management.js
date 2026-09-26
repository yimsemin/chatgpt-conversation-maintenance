import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { assert } from "./assert.js";
import { writeJsonAtomic } from "./fs-json.js";
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
  // 제목 변경은 수정 시각을 바꾼다. 바꾼 대화끼리의 목록 순서를 나중에 확인할 수 있게 그 시각을 영수증에 남긴다.
  return response.data?.update_time ?? null;
}

async function verifyDelete(api, action) {
  const response = await api.getConversation(action.conversationId);
  if (!response.ok && (response.status === 404 || response.status === 410)) return "not-found";
  assert(response.ok, `Could not verify deleted conversation ${action.conversationId}: HTTP ${response.status}`);
  assert(response.data?.is_visible === false, `Delete verification failed for ${action.conversationId}`);
  return "not-visible";
}

function createReceiptFile(receiptDir, receipt) {
  const stamp = receipt.startedAt.replace(/[:.]/g, "-");
  const finalPath = join(receiptDir, `${stamp}_${receipt.runId}.json`);
  writeJsonAtomic(finalPath, receipt);
  return finalPath;
}

// 승인된 제목 변경·삭제를 한 건씩 적용한다. 쓰기 직전에 그 대화를 원격에서 다시 읽어 예상 제목과 맞는지 확인하고,
// 쓴 뒤에는 결과를 다시 읽어 검증한다. 한 건이 실패하면 나머지는 건너뛴다. 결과는 토큰이 없는 영수증에 남는다.
export async function runManagementWorkflow({ manifest: rawManifest, accountId, confirmation, reviewedConversationIds, api, now = () => new Date() }) {
  assert(ACCOUNT_ID.test(accountId || ""), "A valid ChatGPT Business account ID is required");
  assert(api?.getConversation && api?.patchConversation, "Management API adapter is incomplete");

  const manifest = validateManagementManifest(rawManifest);
  const manifestDigest = managementManifestDigest(manifest);
  const expectedConfirmation = managementConfirmation(manifest);
  assert(confirmation === expectedConfirmation, "Confirmation phrase does not match the manifest");
  const expectedReviewedIds = manifest.actions.map((action) => action.conversationId);
  assert(Array.isArray(reviewedConversationIds), "Every action must be reviewed by the user");
  assert(JSON.stringify(reviewedConversationIds) === JSON.stringify(expectedReviewedIds),
    "Reviewed conversation IDs do not exactly match the manifest");

  // 본문 사본(백업)은 쓰기 전에 모두 검증한다. 원격 쪽 검증은 건마다 쓰기 직전에 한다(읽기가 몰리지 않게).
  const backups = new Map();
  const preflight = manifest.actions.map((action) => {
    const item = { conversationId: action.conversationId, expectedTitle: action.expectedTitle, decision: action.decision,
      ...(action.newTitle ? { newTitle: action.newTitle } : {}) };
    try { item.backup = inspectConversationBackup(action); backups.set(action.conversationId, item.backup); item.ok = true; }
    catch (error) { item.ok = false; item.error = error.message; }
    return item;
  });
  if (preflight.some((item) => !item.ok)) {
    return { ok: false, phase: "preflight", manifestDigest, expectedConfirmation, preflight };
  }

  const receipt = {
    version: 1,
    runId: randomUUID(),
    workspace: manifest.workspace,
    ...(manifest.source ? { source: manifest.source } : {}),
    startedAt: now().toISOString(),
    status: "running",
    manifestDigest,
    expectedConfirmation,
    reviewedConversationIds: expectedReviewedIds,
    results: [],
  };
  // 첫 쓰기 전에 영수증 폴더에 쓸 수 있는지 확인한다.
  const receiptFile = createReceiptFile(manifest.receiptDir, receipt);
  let failure = null;

  async function applyAction(action) {
    const result = {
      conversationId: action.conversationId,
      expectedTitle: action.expectedTitle,
      decision: action.decision,
      backup: backups.get(action.conversationId),
      startedAt: now().toISOString(),
      mutations: [],
    };
    // 진행 중 표시: 여기서 죽으면 이 건의 결과가 불확실하다는 것을 다음 실행이 알 수 있다.
    receipt.currentActions = [{ conversationId: action.conversationId, decision: action.decision, startedAt: result.startedAt }];
    writeJsonAtomic(receiptFile, receipt);
    try {
      await readRemote(api, action);

      if (action.newTitle) {
        await api.patchConversation(action.conversationId, { title: action.newTitle });
        const rename = { type: "rename", title: action.newTitle };
        result.mutations.push(rename);
        rename.updateTime = await verifyRename(api, action);
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
      failure = error;
    }
    result.finishedAt = now().toISOString();
    receipt.results.push(result);
    delete receipt.currentActions;
    writeJsonAtomic(receiptFile, receipt);
  }

  let done = 0;
  for (const action of manifest.actions) {
    if (failure) break;
    await applyAction(action);
    done += 1;
  }
  for (const action of manifest.actions.slice(done)) {
    receipt.results.push({
      conversationId: action.conversationId,
      expectedTitle: action.expectedTitle,
      decision: action.decision,
      ok: false,
      skipped: true,
      error: "Skipped because an earlier action failed",
    });
  }

  receipt.status = failure ? "failed" : "completed";
  receipt.finishedAt = now().toISOString();
  writeJsonAtomic(receiptFile, receipt);
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
