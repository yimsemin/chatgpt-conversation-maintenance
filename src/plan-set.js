
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

import { assert } from "./assert.js";
import { readJson } from "./fs-json.js";
import { ACCOUNT_ID } from "./ids.js";
import {
  managementConfirmation,
  managementManifestDigest,
  prepareManagementWorkflow,
  runManagementWorkflow,
  validateManagementManifest,
} from "./management.js";

try { process.umask(0o077); } catch {}


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
  onProgress = () => {},
}) {
  assert(api?.getConversation && api?.patchConversation, "Management API adapter is incomplete");
  assert(ACCOUNT_ID.test(accountId || ""), "A valid ChatGPT Business account ID is required");

  const prepared = preparePlanSet(plansDir);
  if (prepared.summary.remainingActions === 0) {
    return { ok: true, appliedBatches: 0, summary: prepared.summary };
  }
  assert(prepared.summary.uncertainActions.length === 0,
    `Uncertain in-progress receipt actions require manual review: ${prepared.summary.uncertainActions.join(", ")}`);
  assert(confirmation === prepared.summary.expectedConfirmation,
    `Plan-set confirmation does not match. Expected: ${prepared.summary.expectedConfirmation}`);

  let appliedBatches = 0;
  const selectedPlans = prepared.plans.filter((plan) => plan.remainingManifest);
  for (const plan of selectedPlans) {
    const manifest = plan.remainingManifest;
    onProgress({
      type: "batch-start",
      file: plan.path,
      actions: manifest.actions.length,
      batch: appliedBatches + 1,
    });
    const result = await runManagementWorkflow({
      manifest,
      accountId,
      confirmation: managementConfirmation(manifest),
      reviewedConversationIds: manifest.actions.map((action) => action.conversationId),
      api,
      onProgress,
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
  }
  return { ok: true, appliedBatches, summary: loadPlanSet(plansDir).summary };
}
