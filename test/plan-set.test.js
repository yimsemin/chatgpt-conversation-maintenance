import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyPlanSet,
  loadPlanSet,
  preparePlanSet,
} from "../src/plan-set.js";
import { managementManifestDigest } from "../src/management.js";

const ACCOUNT_ID = "11111111-2222-4333-8444-555555555555";
const IDS = [
  "55555555-5555-4555-8555-555555555501",
  "55555555-5555-4555-8555-555555555502",
  "55555555-5555-4555-8555-555555555503",
];
const SOURCE = {
  inventoryDigest: "a".repeat(64),
  decisionsDigest: "b".repeat(64),
};

function planSetFixture() {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-management-cli-test-"));
  const plansDir = join(root, "plans");
  const receiptDir = join(root, "receipts");
  mkdirSync(plansDir);
  mkdirSync(receiptDir);

  const actions = IDS.map((conversationId, index) => {
    const title = `Conversation ${index + 1}`;
    const backupFile = join(root, `conversation-${index + 1}.json`);
    const backup = JSON.stringify({
      conversation_id: conversationId,
      title,
      mapping: { root: { id: "root", message: null } },
    });
    writeFileSync(backupFile, backup);
    return {
      conversationId,
      expectedTitle: title,
      decision: index === 1 ? "delete" : "keep",
      approved: true,
      backupFile,
      backupSha256: createHash("sha256").update(backup).digest("hex"),
      ...(index !== 1 ? { newTitle: `Renamed conversation ${index + 1}` } : {}),
    };
  });
  const manifests = actions.map((action) => ({
    version: 1,
    workspace: "business",
    receiptDir,
    source: SOURCE,
    actions: [action],
  }));
  manifests.forEach((manifest, index) => {
    writeFileSync(join(plansDir, `batch-${String(index + 1).padStart(3, "0")}.json`), JSON.stringify(manifest));
  });
  const completedReceipt = {
    version: 1,
    runId: "completed-run",
    source: SOURCE,
    manifestDigest: managementManifestDigest(manifests[0]),
    status: "completed",
    results: [{
      conversationId: IDS[0],
      expectedTitle: actions[0].expectedTitle,
      decision: "keep",
      mutations: [{ type: "rename", title: actions[0].newTitle }],
      verification: "renamed",
      ok: true,
    }],
  };
  writeFileSync(join(receiptDir, "completed.json"), JSON.stringify(completedReceipt));
  return { root, plansDir, actions };
}

test("receipts skip a completed batch and pending batches are applied and verified in order", async () => {
  const { root, plansDir, actions } = planSetFixture();
  const operations = [];
  const remote = new Map(actions.slice(1).map(({ conversationId, expectedTitle }) =>
    [conversationId, { conversation_id: conversationId, title: expectedTitle, is_visible: true }]));
  const api = {
    async getConversation(id) {
      operations.push(["read", id]);
      return { ok: true, status: 200, data: { ...remote.get(id) } };
    },
    async patchConversation(id, body) {
      operations.push(["write", id]);
      Object.assign(remote.get(id), body);
      return { success: true };
    },
  };
  try {
    const { summary } = preparePlanSet(plansDir);
    assert.equal(summary.plans, 3);
    assert.equal(summary.completedPlans, 1);
    assert.equal(summary.remainingActions, 2);
    assert.equal(summary.remainingDeletes, 1);
    assert.equal(summary.remainingRenames, 1);
    assert.match(summary.expectedConfirmation,
      /^APPLY 2 BATCHES; 2 ACTIONS; DELETE 1 CONVERSATIONS; SET [0-9a-f]{12}$/);
    const result = await applyPlanSet({
      plansDir,
      confirmation: summary.expectedConfirmation,
      accountId: ACCOUNT_ID,
      api,
    });
    assert.equal(result.ok, true);
    assert.equal(result.appliedBatches, 2);
    assert.deepEqual(operations, IDS.slice(1).flatMap((id) => [["read", id], ["write", id], ["read", id]]));
    assert.equal(remote.get(IDS[1]).is_visible, false);
    assert.equal(remote.get(IDS[2]).title, actions[2].newTitle);
    const reloaded = loadPlanSet(plansDir).summary;
    assert.equal(reloaded.remainingActions, 0);
    assert.equal(reloaded.completedActions, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
