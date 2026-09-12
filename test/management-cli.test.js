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
} from "../management-cli.js";
import { managementManifestDigest } from "../management.js";

const ACCOUNT_ID = "11111111-2222-4333-8444-555555555555";
const IDS = [
  "6a66ddf8-ecac-83ee-9311-0d3d3e379345",
  "6a66ddf8-ecac-83ee-9311-0d3d3e379346",
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
      decision: index === 0 ? "keep" : "delete",
      approved: true,
      backupFile,
      backupSha256: createHash("sha256").update(backup).digest("hex"),
      ...(index === 0 ? { newTitle: "Renamed conversation" } : {}),
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
  return { root, plansDir, receiptDir, manifests };
}

test("plan-set status skips actions already proven successful by receipts", () => {
  const fixture = planSetFixture();
  try {
    const planSet = loadPlanSet(fixture.plansDir);
    assert.equal(planSet.summary.plans, 2);
    assert.equal(planSet.summary.completedPlans, 1);
    assert.equal(planSet.summary.remainingActions, 1);
    assert.equal(planSet.summary.remainingDeletes, 1);
    assert.equal(planSet.summary.remainingRenames, 0);
    assert.match(planSet.summary.expectedConfirmation,
      /^APPLY 1 BATCHES; 1 ACTIONS; DELETE 1 CONVERSATIONS; SET [0-9a-f]{12}$/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("preparation validates only pending backups and preserves one plan-set confirmation", () => {
  const fixture = planSetFixture();
  try {
    const prepared = preparePlanSet(fixture.plansDir);
    assert.equal(prepared.pending.length, 1);
    assert.equal(prepared.pending[0].actions, 1);
    assert.equal(prepared.pending[0].deletes, 1);
    assert.equal(prepared.summary.remainingActions, 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("apply runs pending batches serially and a new receipt makes the plan set complete", async () => {
  const fixture = planSetFixture();
  let visible = true;
  const api = {
    getConversation: async (id) => ({
      ok: true,
      status: 200,
      data: {
        conversation_id: id,
        title: fixture.manifests[1].actions[0].expectedTitle,
        is_visible: visible,
      },
    }),
    patchConversation: async (_id, body) => {
      if (body.is_visible === false) visible = false;
      return { success: true };
    },
  };
  try {
    const prepared = preparePlanSet(fixture.plansDir);
    const result = await applyPlanSet({
      plansDir: fixture.plansDir,
      confirmation: prepared.summary.expectedConfirmation,
      accountId: ACCOUNT_ID,
      api,
    });
    assert.equal(result.ok, true);
    assert.equal(result.appliedBatches, 1);
    assert.equal(result.summary.remainingActions, 0);
    assert.equal(result.summary.completedActions, 2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
