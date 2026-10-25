import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  managementConfirmation,
  managementManifestDigest,
  runManagementWorkflow,
  validateManagementManifest,
} from "../src/management.js";

const ID = "55555555-5555-4555-8555-555555555501";
const ACCOUNT_ID = "11111111-2222-4333-8444-555555555555";
const TITLE = "Robocopy로 파일 전송 속도 개선";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-management-test-"));
  const backupFile = join(root, "conversation.json");
  const backup = JSON.stringify({
    conversation_id: ID,
    title: TITLE,
    create_time: 1,
    update_time: 2,
    mapping: { root: { id: "root", message: null } },
  });
  writeFileSync(backupFile, backup);
  const manifest = {
    version: 1,
    workspace: "business",
    receiptDir: join(root, "receipts"),
    actions: [{
      conversationId: ID,
      expectedTitle: TITLE,
      decision: "delete",
      approved: true,
      backupFile,
      backupSha256: createHash("sha256").update(backup).digest("hex"),
    }],
  };
  return { root, backupFile, manifest };
}

test("manifest is strict and confirmation describes destructive scope", () => {
  const { root, manifest } = fixture();
  try {
    const normalized = validateManagementManifest(manifest);
    assert.match(managementManifestDigest(normalized), /^[0-9a-f]{64}$/);
    assert.equal(managementConfirmation(normalized),
      `APPLY 1 ACTIONS; DELETE 1 CONVERSATIONS; PLAN ${managementManifestDigest(normalized).slice(0, 12)}`);
    assert.throws(() => validateManagementManifest({
      ...manifest,
      actions: [{ ...manifest.actions[0], unexpected: true }],
    }), /unknown field/);
    assert.throws(() => validateManagementManifest({
      ...manifest,
      actions: [{ ...manifest.actions[0], newTitle: "rename before delete" }],
    }), /cannot rename/);

    assert.throws(() => validateManagementManifest({
      ...manifest,
      actions: Array.from({ length: 26 }, (_, index) => ({
        ...manifest.actions[0],
        conversationId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      })),
    }), /at most 25/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function applyApi({ title = TITLE, onPatch = () => {} } = {}) {
  const state = { visible: true, reads: 0, patches: [] };
  return {
    state,
    getConversation: async (id) => {
      state.reads += 1;
      return { ok: true, status: 200, data: { conversation_id: id, title, is_archived: false, is_visible: state.visible } };
    },
    patchConversation: async (id, body) => {
      state.patches.push(body);
      if (body.is_visible === false) state.visible = false;
      onPatch(id, body);
      return { success: true };
    },
  };
}

test("apply deletes only after confirmation and review, verifies invisibility, and writes a token-free receipt", async () => {
  const { root, manifest } = fixture();
  const api = applyApi();
  try {
    const confirmation = managementConfirmation(validateManagementManifest(manifest));
    await assert.rejects(runManagementWorkflow({ manifest, accountId: ACCOUNT_ID, confirmation: "wrong", api }), /Confirmation phrase/);
    await assert.rejects(runManagementWorkflow({ manifest, accountId: ACCOUNT_ID, confirmation, api }), /reviewed by the user/);
    assert.equal(api.state.patches.length, 0, "nothing is written before both gates pass");

    const result = await runManagementWorkflow({ manifest, accountId: ACCOUNT_ID, confirmation, reviewedConversationIds: [ID], api });
    assert.equal(result.ok, true);
    assert.deepEqual(api.state.patches, [{ is_visible: false }]);
    assert.equal(result.results[0].verification, "not-visible");
    // 쓰기 직전 확인 한 번 + 쓴 뒤 검증 한 번
    assert.equal(api.state.reads, 2);
    const receiptText = readFileSync(result.receiptFile, "utf8");
    assert.doesNotMatch(receiptText, /accessToken|Bearer|eyJ/);
    assert.equal(JSON.parse(receiptText).status, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a backup that does not match blocks every action before any write", async () => {
  const { root, manifest } = fixture();
  const api = applyApi();
  try {
    writeFileSync(manifest.actions[0].backupFile, "{}");
    const confirmation = managementConfirmation(validateManagementManifest(manifest));
    const result = await runManagementWorkflow({ manifest, accountId: ACCOUNT_ID, confirmation, reviewedConversationIds: [ID], api });
    assert.equal(result.ok, false);
    assert.equal(result.phase, "preflight");
    assert.equal(api.state.patches.length, 0);
    assert.equal(existsSync(manifest.receiptDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a conversation whose remote title changed is not written and the rest are skipped", async () => {
  const { root, manifest } = fixture();
  const secondId = "55555555-5555-4555-8555-555555555502";
  const backup = JSON.stringify({ conversation_id: secondId, title: TITLE, create_time: 1, update_time: 2, mapping: { root: { id: "root", message: null } } });
  const secondFile = join(root, "second.json");
  writeFileSync(secondFile, backup);
  const second = { ...manifest.actions[0], conversationId: secondId, backupFile: secondFile, backupSha256: createHash("sha256").update(backup).digest("hex") };
  const two = { ...manifest, actions: [manifest.actions[0], second] };
  const api = applyApi({ title: "different title" });
  try {
    const confirmation = managementConfirmation(validateManagementManifest(two));
    const result = await runManagementWorkflow({ manifest: two, accountId: ACCOUNT_ID, confirmation,
      reviewedConversationIds: two.actions.map((a) => a.conversationId), api });
    assert.equal(result.ok, false);
    assert.match(result.error, /Remote title does not match/);
    assert.equal(api.state.patches.length, 0);
    assert.deepEqual(result.results.map((r) => [r.ok, r.skipped === true]), [[false, false], [false, true]]);
    assert.equal(JSON.parse(readFileSync(result.receiptFile, "utf8")).status, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
