import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectConversationBackup,
  managementConfirmation,
  managementManifestDigest,
  prepareManagementWorkflow,
  runManagementWorkflow,
  validateManagementManifest,
} from "../management.js";

const ID = "6a66ddf8-ecac-83ee-9311-0d3d3e379345";
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

test("backup inspection binds the full ID, exact title, mapping, and digest", () => {
  const { root, manifest } = fixture();
  try {
    const action = validateManagementManifest(manifest).actions[0];
    const backup = inspectConversationBackup(action);
    assert.equal(backup.path, action.backupFile);
    assert.match(backup.sha256, /^[0-9a-f]{64}$/);
    assert.ok(backup.bytes > 0);

    action.expectedTitle = "wrong title";
    assert.throws(() => inspectConversationBackup(action), /title does not match/);
    action.expectedTitle = TITLE;
    writeFileSync(action.backupFile, `${readFileSync(action.backupFile, "utf8")}\n`);
    assert.throws(() => inspectConversationBackup(action), /SHA-256 does not match/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local preparation validates backups and builds review data without remote access", () => {
  const { root, manifest } = fixture();
  try {
    const result = prepareManagementWorkflow(manifest);
    assert.equal(result.ok, true);
    assert.equal(result.phase, "prepare");
    assert.equal(result.expectedConfirmation, managementConfirmation(manifest));
    assert.equal(result.review.length, 1);
    assert.equal(result.review[0].conversationId, ID);
    assert.equal(result.review[0].backup.sha256, manifest.actions[0].backupSha256);
    assert.equal(existsSync(manifest.receiptDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight performs no mutation", async () => {
  const { root, manifest } = fixture();
  let patches = 0;
  const api = {
    getConversation: async () => ({
      ok: true,
      status: 200,
      data: { conversation_id: ID, title: TITLE, is_archived: false },
    }),
    patchConversation: async () => { patches++; },
  };
  try {
    const result = await runManagementWorkflow({ mode: "preflight", manifest, accountId: ACCOUNT_ID, api });
    assert.equal(result.ok, true);
    assert.equal(result.phase, "preflight");
    assert.equal(patches, 0);
    assert.equal(existsSync(manifest.receiptDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply deletes only after confirmation, verifies invisibility, and writes a token-free receipt", async () => {
  const { root, manifest } = fixture();
  let visible = true;
  const patches = [];
  const api = {
    getConversation: async () => ({
      ok: true,
      status: 200,
      data: { conversation_id: ID, title: TITLE, is_archived: false, is_visible: visible },
    }),
    patchConversation: async (id, body) => {
      assert.equal(id, ID);
      patches.push(body);
      if (body.is_visible === false) visible = false;
      return { success: true };
    },
  };
  try {
    await assert.rejects(
      runManagementWorkflow({ mode: "apply", manifest, accountId: ACCOUNT_ID, confirmation: "wrong", api }),
      /Confirmation phrase/
    );
    assert.equal(patches.length, 0);

    const normalized = validateManagementManifest(manifest);
    const confirmation = managementConfirmation(normalized);
    await assert.rejects(
      runManagementWorkflow({ mode: "apply", manifest, accountId: ACCOUNT_ID, confirmation, api }),
      /reviewed by the user/
    );
    assert.equal(patches.length, 0);

    const result = await runManagementWorkflow({
      mode: "apply",
      manifest,
      accountId: ACCOUNT_ID,
      confirmation,
      reviewedConversationIds: [ID],
      api,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(patches, [{ is_visible: false }]);
    assert.equal(result.results[0].verification, "not-visible");
    assert.equal(result.manifestDigest, managementManifestDigest(normalized));
    const receiptText = readFileSync(result.receiptFile, "utf8");
    assert.doesNotMatch(receiptText, /accessToken|Bearer|eyJ/);
    assert.equal(JSON.parse(receiptText).status, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("efficient apply keeps per-action preflight and post-write verification without a duplicate batch read", async () => {
  const { root, manifest } = fixture();
  let visible = true;
  let reads = 0;
  const api = {
    getConversation: async () => {
      reads++;
      return {
        ok: true,
        status: 200,
        data: { conversation_id: ID, title: TITLE, is_archived: false, is_visible: visible },
      };
    },
    patchConversation: async (_id, body) => {
      if (body.is_visible === false) visible = false;
      return { success: true };
    },
  };
  try {
    const confirmation = managementConfirmation(validateManagementManifest(manifest));
    const result = await runManagementWorkflow({
      mode: "apply",
      manifest,
      accountId: ACCOUNT_ID,
      confirmation,
      reviewedConversationIds: [ID],
      api,
      recheckBeforeEachWrite: false,
    });
    assert.equal(result.ok, true);
    assert.equal(reads, 2);
    assert.equal(result.results[0].verification, "not-visible");
    assert.equal(JSON.parse(readFileSync(result.receiptFile, "utf8")).verificationProfile, "efficient");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("efficient apply can verify and mutate three independent actions concurrently", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-management-parallel-test-"));
  const ids = [
    ID,
    "6a66ddf8-ecac-83ee-9311-0d3d3e379346",
    "6a66ddf8-ecac-83ee-9311-0d3d3e379347",
  ];
  const states = new Map();
  const actions = ids.map((id, index) => {
    const title = `${TITLE} ${index + 1}`;
    const backupFile = join(root, `conversation-${index}.json`);
    const backup = JSON.stringify({
      conversation_id: id,
      title,
      create_time: 1,
      update_time: 2,
      mapping: { root: { id: "root", message: null } },
    });
    writeFileSync(backupFile, backup);
    states.set(id, { title, visible: true });
    return {
      conversationId: id,
      expectedTitle: title,
      decision: "delete",
      approved: true,
      backupFile,
      backupSha256: createHash("sha256").update(backup).digest("hex"),
    };
  });
  const manifest = {
    version: 1,
    workspace: "business",
    receiptDir: join(root, "receipts"),
    actions,
  };
  let activePatches = 0;
  let peakPatches = 0;
  const api = {
    getConversation: async (id) => {
      const state = states.get(id);
      return {
        ok: true,
        status: 200,
        data: { conversation_id: id, title: state.title, is_visible: state.visible },
      };
    },
    patchConversation: async (id, body) => {
      activePatches++;
      peakPatches = Math.max(peakPatches, activePatches);
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (body.is_visible === false) states.get(id).visible = false;
      activePatches--;
      return { success: true };
    },
  };
  try {
    const confirmation = managementConfirmation(validateManagementManifest(manifest));
    const result = await runManagementWorkflow({
      mode: "apply",
      manifest,
      accountId: ACCOUNT_ID,
      confirmation,
      reviewedConversationIds: ids,
      api,
      recheckBeforeEachWrite: false,
      actionConcurrency: 3,
    });
    assert.equal(result.ok, true);
    assert.equal(peakPatches, 3);
    assert.equal(result.results.length, 3);
    assert.ok(result.results.every((item) => item.ok && item.verification === "not-visible"));
    const receipt = JSON.parse(readFileSync(result.receiptFile, "utf8"));
    assert.equal(receipt.actionConcurrency, 3);
    assert.equal(receipt.status, "completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a preflight mismatch blocks every action", async () => {
  const { root, manifest } = fixture();
  let patches = 0;
  const api = {
    getConversation: async () => ({
      ok: true,
      status: 200,
      data: { conversation_id: ID, title: "different title" },
    }),
    patchConversation: async () => { patches++; },
  };
  try {
    const result = await runManagementWorkflow({ mode: "apply", manifest, accountId: ACCOUNT_ID, confirmation: "anything", api });
    assert.equal(result.ok, false);
    assert.equal(result.phase, "preflight");
    assert.equal(patches, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
