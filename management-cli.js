#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assert } from "./assert.js";
import { ACCOUNT_ID } from "./ids.js";
import {
  managementConfirmation,
  managementManifestDigest,
  prepareManagementWorkflow,
  runManagementWorkflow,
  validateManagementManifest,
} from "./management.js";

try { process.umask(0o077); } catch {}

const MODULE_ROOT = dirname(fileURLToPath(import.meta.url));

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`${label} is not valid JSON: ${path}`); }
}

function jsonFiles(path) {
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => resolve(path, entry.name))
    .sort((a, b) => basename(a).localeCompare(basename(b)));
}

function sameSource(left, right) {
  return Boolean(left && right
    && left.inventoryDigest === right.inventoryDigest
    && left.decisionsDigest === right.decisionsDigest);
}

function resultMatchesAction(receipt, result, plan) {
  const action = plan.actionById.get(result?.conversationId);
  if (!action || result.ok !== true) return false;
  if (receipt.manifestDigest !== plan.digest && !sameSource(receipt.source, plan.manifest.source)) return false;
  if (result.expectedTitle !== action.expectedTitle || result.decision !== action.decision) return false;
  const mutations = Array.isArray(result.mutations) ? result.mutations : [];
  if (action.newTitle) {
    if (!mutations.some((mutation) => mutation?.type === "rename" && mutation.title === action.newTitle)) return false;
  }
  if (action.decision === "delete") {
    return mutations.some((mutation) => mutation?.type === "delete")
      && ["not-found", "not-visible"].includes(result.verification);
  }
  if (action.decision === "archive") {
    return mutations.some((mutation) => mutation?.type === "archive") && result.verification === "archived";
  }
  return true;
}

function currentActionMatchesPlan(receipt, current, plan) {
  const action = plan.actionById.get(current?.conversationId);
  if (!action) return false;
  if (receipt.manifestDigest !== plan.digest && !sameSource(receipt.source, plan.manifest.source)) return false;
  return current.decision === action.decision;
}

function loadReceipts(receiptDirs) {
  const receipts = [];
  for (const receiptDir of [...receiptDirs].sort()) {
    let stat;
    try { stat = statSync(receiptDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const path of jsonFiles(receiptDir)) {
      const receipt = readJson(path, "Receipt");
      receipts.push({ path, receipt });
    }
  }
  return receipts;
}

function remainingManifest(plan, successfulIds) {
  const actions = plan.manifest.actions.filter((action) => !successfulIds.has(action.conversationId));
  if (actions.length === 0) return null;
  return validateManagementManifest({ ...plan.manifest, actions });
}

function planSetDigest(plans) {
  const normalized = plans.map((plan) => ({
    file: basename(plan.path),
    originalDigest: plan.digest,
    remainingConversationIds: plan.remainingManifest.actions.map((action) => action.conversationId),
  }));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function summarizePlans(plans, uncertainIds) {
  const pending = plans.filter((plan) => plan.remainingManifest);
  const digest = pending.length > 0 ? planSetDigest(pending) : null;
  const remainingActions = pending.flatMap((plan) => plan.remainingManifest.actions);
  const deletes = remainingActions.filter((action) => action.decision === "delete").length;
  const renames = remainingActions.filter((action) => action.newTitle).length;
  const totalActions = plans.reduce((sum, plan) => sum + plan.manifest.actions.length, 0);
  const completedActions = totalActions - remainingActions.length;
  return {
    plans: plans.length,
    completedPlans: plans.length - pending.length,
    pendingPlans: pending.length,
    totalActions,
    completedActions,
    remainingActions: remainingActions.length,
    remainingDeletes: deletes,
    remainingRenames: renames,
    uncertainActions: [...uncertainIds].sort(),
    planSetDigest: digest,
    expectedConfirmation: digest
      ? `APPLY ${pending.length} BATCHES; ${remainingActions.length} ACTIONS; DELETE ${deletes} CONVERSATIONS; SET ${digest.slice(0, 12)}`
      : null,
  };
}

export function loadPlanSet(plansDir) {
  const root = resolve(plansDir);
  let stat;
  try { stat = statSync(root); } catch { throw new Error(`Plans directory not found: ${root}`); }
  assert(stat.isDirectory(), `Plans path is not a directory: ${root}`);
  const paths = jsonFiles(root);
  assert(paths.length > 0, `Plans directory contains no JSON manifests: ${root}`);

  const plans = paths.map((path) => {
    const manifest = validateManagementManifest(readJson(path, "Manifest"));
    return {
      path,
      manifest,
      digest: managementManifestDigest(manifest),
      actionById: new Map(manifest.actions.map((action) => [action.conversationId, action])),
    };
  });
  const planByConversationId = new Map();
  for (const plan of plans) {
    for (const action of plan.manifest.actions) {
      assert(!planByConversationId.has(action.conversationId),
        `Conversation appears in more than one plan: ${action.conversationId}`);
      planByConversationId.set(action.conversationId, plan);
    }
  }

  const receipts = loadReceipts(new Set(plans.map((plan) => plan.manifest.receiptDir)));
  const successfulIds = new Set();
  const uncertainIds = new Set();
  for (const { receipt } of receipts) {
    for (const result of receipt.results || []) {
      const plan = planByConversationId.get(result?.conversationId);
      if (plan && resultMatchesAction(receipt, result, plan)) successfulIds.add(result.conversationId);
    }
    const currentActions = [
      ...(Array.isArray(receipt.currentActions) ? receipt.currentActions : []),
      ...(receipt.currentAction ? [receipt.currentAction] : []),
    ];
    for (const current of currentActions) {
      const plan = planByConversationId.get(current?.conversationId);
      if (plan && currentActionMatchesPlan(receipt, current, plan) && !successfulIds.has(current.conversationId)) {
        uncertainIds.add(current.conversationId);
      }
    }
  }
  for (const conversationId of successfulIds) uncertainIds.delete(conversationId);

  for (const plan of plans) plan.remainingManifest = remainingManifest(plan, successfulIds);
  return {
    root,
    plans,
    receipts,
    successfulIds,
    uncertainIds,
    summary: summarizePlans(plans, uncertainIds),
  };
}

export function preparePlanSet(plansDir) {
  const planSet = loadPlanSet(plansDir);
  const pending = [];
  for (const plan of planSet.plans) {
    if (!plan.remainingManifest) continue;
    const prepared = prepareManagementWorkflow(plan.remainingManifest);
    pending.push({
      file: plan.path,
      actions: prepared.review.length,
      deletes: prepared.review.filter((item) => item.decision === "delete").length,
      renames: prepared.review.filter((item) => item.newTitle).length,
      manifestDigest: prepared.manifestDigest,
      batchConfirmation: prepared.expectedConfirmation,
    });
  }
  return { ...planSet, pending };
}

export async function applyPlanSet({
  plansDir,
  confirmation,
  accountId,
  api,
  maxBatches = Number.POSITIVE_INFINITY,
  batchDelayMs = 0,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  onProgress = () => {},
}) {
  assert(api?.getConversation && api?.patchConversation, "Management API adapter is incomplete");
  assert(ACCOUNT_ID.test(accountId || ""), "A valid ChatGPT Business account ID is required");
  assert((Number.isInteger(maxBatches) && maxBatches > 0) || maxBatches === Number.POSITIVE_INFINITY,
    "maxBatches must be a positive integer");
  assert(Number.isInteger(batchDelayMs) && batchDelayMs >= 0, "batchDelayMs must be a non-negative integer");

  const prepared = preparePlanSet(plansDir);
  if (prepared.summary.remainingActions === 0) {
    return { ok: true, appliedBatches: 0, summary: prepared.summary };
  }
  assert(prepared.summary.uncertainActions.length === 0,
    `Uncertain in-progress receipt actions require manual review: ${prepared.summary.uncertainActions.join(", ")}`);
  assert(confirmation === prepared.summary.expectedConfirmation,
    `Plan-set confirmation does not match. Expected: ${prepared.summary.expectedConfirmation}`);

  let appliedBatches = 0;
  const selectedPlans = prepared.plans
    .filter((plan) => plan.remainingManifest)
    .slice(0, maxBatches);
  for (const [selectedIndex, plan] of selectedPlans.entries()) {
    const manifest = plan.remainingManifest;
    onProgress({
      type: "batch-start",
      file: plan.path,
      actions: manifest.actions.length,
      batch: appliedBatches + 1,
    });
    const result = await runManagementWorkflow({
      mode: "apply",
      manifest,
      accountId,
      confirmation: managementConfirmation(manifest),
      reviewedConversationIds: manifest.actions.map((action) => action.conversationId),
      api,
      recheckBeforeEachWrite: false,
      actionConcurrency: 1,
    });
    appliedBatches++;
    onProgress({
      type: "batch-finish",
      file: plan.path,
      ok: result.ok,
      receiptFile: result.receiptFile,
      actions: manifest.actions.length,
    });
    if (!result.ok) {
      return {
        ok: false,
        appliedBatches,
        error: result.error || "Management batch failed",
        receiptFile: result.receiptFile,
        summary: loadPlanSet(plansDir).summary,
      };
    }
    if (batchDelayMs > 0 && selectedIndex + 1 < selectedPlans.length) await sleep(batchDelayMs);
  }
  return { ok: true, appliedBatches, summary: loadPlanSet(plansDir).summary };
}

function usage() {
  return [
    "Usage:",
    "  node management-cli.js status <plans-dir>",
    "  node management-cli.js prepare <plans-dir>",
    "  원격 apply 명령은 폐기되었습니다. 로컬 앱을 사용하세요.",
    "",
    "Apply options:",
    "  --data-dir <path>           Data folder holding the maintenance lock (default: <repo>/data)",
    "  --account-id <uuid>          Override the account ID from the session JSON/JWT",
    "  --max-batches <number>       Stop after this many pending batches",
    "  --batch-delay-seconds <n>    Wait between completed batches",
    "  --request-delay-seconds <n>  Wait after each completed HTTP request (default: 2)",
  ].join("\n");
}

function parseApplyArgs(values) {
  assert(values.length >= 1, usage());
  const plansDir = values[0];
  let confirmation = "";
  let accountId = "";
  let dataDir = "";
  let maxBatches = Number.POSITIVE_INFINITY;
  let batchDelayMs = 0;
  let requestDelayMs = 2000;
  for (let index = 1; index < values.length; index++) {
    const option = values[index];
    const value = values[++index];
    assert(value !== undefined, `Missing value for ${option}`);
    if (option === "--confirmation") confirmation = value;
    else if (option === "--account-id") accountId = value;
    else if (option === "--data-dir") dataDir = value;
    else if (option === "--max-batches") {
      maxBatches = Number(value);
      assert(Number.isInteger(maxBatches) && maxBatches > 0, "--max-batches must be a positive integer");
    } else if (option === "--batch-delay-seconds") {
      const seconds = Number(value);
      assert(Number.isFinite(seconds) && seconds >= 0, "--batch-delay-seconds must be non-negative");
      batchDelayMs = Math.round(seconds * 1000);
    } else if (option === "--request-delay-seconds") {
      const seconds = Number(value);
      assert(Number.isFinite(seconds) && seconds >= 0, "--request-delay-seconds must be non-negative");
      requestDelayMs = Math.round(seconds * 1000);
    } else throw new Error(`Unknown option: ${option}\n${usage()}`);
  }
  return { plansDir, confirmation, accountId, dataDir, maxBatches, batchDelayMs, requestDelayMs };
}

async function main(args) {
  const [command, ...values] = args;
  if (command === "status" && values.length === 1) {
    console.log(JSON.stringify(loadPlanSet(values[0]).summary, null, 2));
    return;
  }
  if (command === "prepare" && values.length === 1) {
    const prepared = preparePlanSet(values[0]);
    console.log(JSON.stringify({ summary: prepared.summary, pending: prepared.pending }, null, 2));
    return;
  }
  if (command === "apply") {
    throw new Error("원격 apply CLI는 폐기되었습니다. 로컬 앱을 사용하세요.");
  }
  throw new Error(usage());
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
