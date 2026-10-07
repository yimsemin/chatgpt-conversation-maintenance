import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSafeDiagnostic } from "../src/web-common.js";
import { buildReviewedDecisions, buildReviewedDecisionsFromInputs } from "../src/web-decisions.js";
import { jobEvent } from "../src/web-jobs.js";
import { planReuseDecision, resumableRunDir } from "../src/web-workflows.js";

function inventoryFixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "maintenance-web-inv-"));
  const inventoryPath = join(root, "inventory.json");
  writeFileSync(inventoryPath, JSON.stringify({
    version: 1,
    kind: "conversation-maintenance-inventory",
    warnings: [],
    projects: [{ projectName: "조사" }],
    conversations: [
      { conversationId: "c-new", title: "임시 제목", projectName: null },
      { conversationId: "c-proj", title: "기존 — 제목", projectName: "조사" },
    ],
    ...overrides,
  }));
  return {
    root,
    inventoryPath,
    pointer: { runDir: root, inventoryPath },
    inventory: JSON.parse(readFileSync(inventoryPath, "utf8")),
  };
}

test("approved proposals become complete reviewed decisions without extra fields", () => {
  const pointer = { runDir: "/tmp/local-run" };
  const result = buildReviewedDecisions(pointer, {
    inventoryDigest: "abc",
    items: [
      {
        conversationId: "keep-id",
        suggestedDecision: "keep",
        suggestedNewTitle: "주제 — 정리 결과",
        suggestedProjectAction: "use-or-create",
        suggestedProjectName: "조사",
        rationale: "보존 가치가 있다.",
      },
      {
        conversationId: "delete-id",
        suggestedDecision: "delete",
        suggestedProjectAction: "none",
        rationale: "재사용 가치가 없다.",
      },
    ],
  });

  assert.equal(result.kind, "reviewed-decisions");
  assert.equal(result.decisions.length, 2);
  assert.deepEqual(result.decisions[0], {
    conversationId: "keep-id",
    decision: "keep",
    newTitle: "주제 — 정리 결과",
    projectName: "조사",
    reviewed: true,
    rationale: "보존 가치가 있다.",
  });
  assert.deepEqual(result.decisions[1], {
    conversationId: "delete-id",
    decision: "delete",
    reviewed: true,
    rationale: "재사용 가치가 없다.",
  });
});

test("jobEvent updates a running progress line in place instead of piling up", () => {
  const job = { events: [] };
  jobEvent(job, "lock", "로컬 유지관리 잠금을 획득합니다.");
  jobEvent(job, "progress", "후보 대화 본문 받는 중 (1/3건, 33%)");
  jobEvent(job, "progress", "후보 대화 본문 받는 중 (2/3건, 66%)");
  jobEvent(job, "progress", "후보 대화 본문 받는 중 (3/3건, 100%)");
  jobEvent(job, "ready", "3개 후보의 분류 요청 준비가 끝났습니다.");
  assert.equal(job.events.length, 3);
  assert.equal(job.events[1].stage, "progress");
  assert.equal(job.events[1].message, "후보 대화 본문 받는 중 (3/3건, 100%)");
  assert.equal(job.events[2].stage, "ready");
});

test("GUI decisions validate against every maintenance candidate", () => {
  const { root, pointer, inventory } = inventoryFixture();
  try {
    const result = buildReviewedDecisionsFromInputs(pointer, inventory, [
      { conversationId: "c-new", decision: "keep", newTitle: "새 주제 — 정리 결과", projectName: "신규 조사" },
      { conversationId: "c-proj", decision: "delete" },
    ]);
    assert.equal(result.kind, "reviewed-decisions");
    assert.match(result.inventoryDigest, /^[0-9a-f]{64}$/);
    assert.equal(result.receiptDir, join(root, "receipts"));
    assert.deepEqual(result.decisions[0], {
      conversationId: "c-new", decision: "keep", newTitle: "새 주제 — 정리 결과", projectName: "신규 조사", reviewed: true,
    });
    assert.deepEqual(result.decisions[1], { conversationId: "c-proj", decision: "delete", reviewed: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GUI decisions reject partial coverage and bad titles (unless the rename was unchecked), and allow cross-project moves", () => {
  const { root, pointer, inventory } = inventoryFixture();
  try {
    assert.throws(() => buildReviewedDecisionsFromInputs(pointer, inventory, [
      { conversationId: "c-new", decision: "keep", newTitle: "주제 — 결과", projectName: "조사" },
    ]), /하나의 결정/);
    assert.throws(() => buildReviewedDecisionsFromInputs(pointer, inventory, [
      { conversationId: "c-new", decision: "keep", newTitle: "형식없는제목", projectName: "조사" },
      { conversationId: "c-proj", decision: "keep", projectName: "조사" },
    ]), /주제 — 작업\/결과/);
    const moved = buildReviewedDecisionsFromInputs(pointer, inventory, [
      { conversationId: "c-new", decision: "keep", newTitle: "주제 — 결과", projectName: "조사" },
      { conversationId: "c-proj", decision: "keep", projectName: "다른 프로젝트" },
    ]);
    assert.equal(moved.decisions[1].projectName, "다른 프로젝트");
    assert.throws(() => buildReviewedDecisionsFromInputs(pointer, inventory, [
      { conversationId: "c-new", decision: "delete", newTitle: "주제 — 결과" },
      { conversationId: "c-proj", decision: "keep", projectName: "조사" },
    ]), /제목은 바꿀 수 없습니다/);
    const kept = buildReviewedDecisionsFromInputs(pointer, inventory, [
      { conversationId: "c-new", decision: "keep", newTitle: "임시 제목", keepTitle: true, projectName: "" },
      { conversationId: "c-proj", decision: "keep", projectName: "조사" },
    ]);
    assert.equal(kept.decisions[0].keepTitle, true);
    assert.equal(kept.decisions[0].newTitle, undefined);
    assert.throws(() => buildReviewedDecisionsFromInputs(pointer, inventory, [
      { conversationId: "c-new", decision: "keep", projectName: "" },
      { conversationId: "c-proj", decision: "keep", projectName: "조사" },
    ]), /주제 — 작업\/결과/);
    const projectless = buildReviewedDecisionsFromInputs(pointer, inventory, [
      { conversationId: "c-new", decision: "keep", newTitle: "주제 — 결과", projectName: "" },
      { conversationId: "c-proj", decision: "keep", projectName: "조사" },
    ]);
    assert.equal(projectless.decisions[0].projectName, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GUI decisions refuse an inventory that still carries warnings", () => {
  const { root, pointer, inventory } = inventoryFixture({ warnings: ["불완전한 내보내기"] });
  try {
    assert.throws(() => buildReviewedDecisionsFromInputs(pointer, inventory, [
      { conversationId: "c-new", decision: "delete" },
    ]), /경고가 있어/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copyable diagnostics redact tokens and the private workspace path", () => {
  const workspace = join(tmpdir(), "private-workspace");
  const token = "eyJheader.payload.signature";
  const result = createSafeDiagnostic("scan", new Error(
    `Bearer ${token} failed in ${workspace}/data/runs/x.json`,
  ), workspace, "run-1");
  const serialized = JSON.stringify(result);
  assert.equal(result.stage, "scan");
  assert.equal(result.runId, "run-1");
  assert.doesNotMatch(serialized, /eyJheader/);
  assert.equal(serialized.includes(workspace), false);
  assert.match(serialized, /<redacted>/);
  assert.match(serialized, /<workspace>/);
});

// ---- 적용 실패 후 결정을 바꿨을 때의 계획 재사용 ----

const DECISIONS_DIGEST = "d".repeat(64);

test("plan reuse follows the decisions digest: reuse, compile, recompile or halt once anything was applied", () => {
  const decide = (state) => planReuseDecision({ hasCompiledArtifacts: true, stampDigest: DECISIONS_DIGEST, decisionsDigest: DECISIONS_DIGEST, hasReceipts: false, ...state });
  assert.deepEqual(decide({ hasReceipts: true }), { action: "reuse", reason: "match" });
  assert.equal(decide({ hasCompiledArtifacts: false, stampDigest: null }).action, "compile");
  assert.deepEqual(decide({ stampDigest: "a".repeat(64) }), { action: "recompile", reason: "changed" });
  assert.deepEqual(decide({ stampDigest: "a".repeat(64), hasReceipts: true }), { action: "halt", reason: "changed-after-apply" });
  assert.deepEqual(decide({ stampDigest: null }), { action: "recompile", reason: "unknown-source" });
  assert.deepEqual(decide({ stampDigest: null, hasReceipts: true }), { action: "halt", reason: "unknown-source-after-apply" });
});

test("an interrupted collection of the same scope resumes its run folder; other scopes, finished runs and stale folders start a new one", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "maintenance-resume-"));
  try {
    const scope = { kind: "recent", days: 7 };
    const first = resumableRunDir(dataDir, scope);
    mkdirSync(join(first, "json"), { recursive: true });
    assert.equal(resumableRunDir(dataDir, scope), first);
    assert.notEqual(resumableRunDir(dataDir, { kind: "recent", days: 14 }), first);
    assert.notEqual(resumableRunDir(dataDir, scope, { now: Date.now() + 25 * 3600 * 1000 }), first);
    writeFileSync(join(first, "inventory.json"), "{}");
    assert.notEqual(resumableRunDir(dataDir, scope), first);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
