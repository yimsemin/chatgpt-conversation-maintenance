import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertApplyablePhase,
  buildReviewedDecisions,
  buildReviewedDecisionsFromInputs,
  createSafeDiagnostic,
  formatScanProgress,
  jobEvent,
  planReuseDecision,
  validateMaintenanceWorkspace,
} from "../maintenance-web.js";
import { compileProjectRouting, compileReviewedDecisions } from "../decision-compile.js";

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

function workspaceFixture() {
  const root = mkdtempSync(join(tmpdir(), "maintenance-web-"));
  mkdirSync(join(root, "data"));
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "chatgpt-conversation-maintenance",
  }));
  return root;
}

test("maintenance web validates only a maintenance workspace", () => {
  const root = workspaceFixture();
  try {
    const result = validateMaintenanceWorkspace(root);
    assert.equal(result.workspace, root);
    assert.equal(result.dataDir, join(root, "data"));
    assert.deepEqual(Object.keys(result).sort(), ["dataDir", "workspace"]);

    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "another-project" }));
    assert.throws(() => validateMaintenanceWorkspace(root), /유지관리 프로젝트/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("web approval refuses undecided but now accepts manual project moves", () => {
  const pointer = { runDir: "/tmp/local-run" };
  assert.throws(() => buildReviewedDecisions(pointer, {
    inventoryDigest: "abc",
    items: [{ suggestedDecision: "undecided", suggestedProjectAction: "use-or-create" }],
  }), /undecided/);
  const result = buildReviewedDecisions(pointer, {
    inventoryDigest: "abc",
    items: [{
      conversationId: "c-1",
      suggestedDecision: "keep",
      suggestedProjectAction: "manual-move",
      suggestedProjectName: "다른 프로젝트",
      rationale: "테스트",
    }],
  });
  assert.deepEqual(result.decisions[0], {
    conversationId: "c-1",
    decision: "keep",
    projectName: "다른 프로젝트",
    reviewed: true,
    rationale: "테스트",
  });
});

test("jobEvent updates a running progress line in place instead of piling up", () => {
  const job = { events: [] };
  jobEvent(job, "lock", "로컬 유지관리 잠금을 획득합니다.");
  jobEvent(job, "progress", "후보 대화 다운로드 중 (1/3, 33%)");
  jobEvent(job, "progress", "후보 대화 다운로드 중 (2/3, 66%)");
  jobEvent(job, "progress", "후보 대화 다운로드 중 (3/3, 100%)");
  jobEvent(job, "ready", "3개 후보의 분류 요청 준비가 끝났습니다.");
  assert.equal(job.events.length, 3);
  assert.equal(job.events[1].stage, "progress");
  assert.equal(job.events[1].message, "후보 대화 다운로드 중 (3/3, 100%)");
  assert.equal(job.events[2].stage, "ready");
});

test("formatScanProgress renders a percentage once a total is known", () => {
  assert.equal(formatScanProgress({ phase: "downloads", index: 42, total: 139 }),
    "후보 대화 다운로드 중 (42/139, 30%)");
  assert.equal(formatScanProgress({ phase: "active", index: 100, total: 424 }),
    "활성 대화 목록 확인 중 (100/424, 24%)");
  assert.equal(formatScanProgress({ phase: "projects", index: 2, total: 9, projectName: "오디오" }),
    "프로젝트 목록 확인 중: 오디오 (3/9)");
  assert.equal(formatScanProgress({ phase: "removed", index: 0, total: 0 }), "삭제된 대화 확인 중");
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

test("GUI decisions reject partial coverage and bad titles, but now allow cross-project moves", () => {
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

test("unchanged decisions keep the compiled plans and their receipts", () => {
  assert.deepEqual(planReuseDecision({
    hasCompiledArtifacts: true,
    stampDigest: DECISIONS_DIGEST,
    decisionsDigest: DECISIONS_DIGEST,
    hasReceipts: true,
  }), { action: "reuse", reason: "match" });
});

test("a first apply compiles plans", () => {
  assert.equal(planReuseDecision({
    hasCompiledArtifacts: false,
    stampDigest: null,
    decisionsDigest: DECISIONS_DIGEST,
    hasReceipts: false,
  }).action, "compile");
});

test("decisions changed before anything was applied are recompiled", () => {
  assert.deepEqual(planReuseDecision({
    hasCompiledArtifacts: true,
    stampDigest: "a".repeat(64),
    decisionsDigest: DECISIONS_DIGEST,
    hasReceipts: false,
  }), { action: "recompile", reason: "changed" });
});

test("decisions changed after a partial apply halt instead of reusing or discarding plans", () => {
  assert.deepEqual(planReuseDecision({
    hasCompiledArtifacts: true,
    stampDigest: "a".repeat(64),
    decisionsDigest: DECISIONS_DIGEST,
    hasReceipts: true,
  }), { action: "halt", reason: "changed-after-apply" });
});

test("plans of unknown origin are recompiled only while no receipt exists", () => {
  assert.deepEqual(planReuseDecision({
    hasCompiledArtifacts: true,
    stampDigest: null,
    decisionsDigest: DECISIONS_DIGEST,
    hasReceipts: false,
  }), { action: "recompile", reason: "unknown-source" });
  assert.deepEqual(planReuseDecision({
    hasCompiledArtifacts: true,
    stampDigest: null,
    decisionsDigest: DECISIONS_DIGEST,
    hasReceipts: true,
  }), { action: "halt", reason: "unknown-source-after-apply" });
});

function runFixture() {
  const root = mkdtempSync(join(tmpdir(), "maintenance-web-run-"));
  const inventoryPath = join(root, "inventory.json");
  writeFileSync(inventoryPath, JSON.stringify({
    version: 1,
    kind: "conversation-maintenance-inventory",
    warnings: [],
    projects: [],
    conversations: [
      {
        conversationId: "11111111-1111-4111-8111-111111111111",
        title: "임시 제목 하나",
        projectName: null,
        backupFile: join(root, "a.json"),
        backupSha256: "a".repeat(64),
      },
      {
        conversationId: "22222222-2222-4222-8222-222222222222",
        title: "보존 주제 — 정리 결과",
        projectName: null,
        backupFile: join(root, "b.json"),
        backupSha256: "b".repeat(64),
      },
    ],
  }));
  const inventoryDigest = createHash("sha256").update(readFileSync(inventoryPath)).digest("hex");
  const decisionsPath = join(root, "reviewed-decisions.json");
  const writeDecisions = (first) => {
    writeFileSync(decisionsPath, JSON.stringify({
      version: 1,
      kind: "reviewed-decisions",
      inventoryDigest,
      receiptDir: join(root, "receipts"),
      decisions: [first, {
        conversationId: "22222222-2222-4222-8222-222222222222",
        decision: "keep",
        projectName: "조사",
        reviewed: true,
      }],
    }));
    return createHash("sha256").update(readFileSync(decisionsPath)).digest("hex");
  };
  return { root, inventoryPath, decisionsPath, writeDecisions };
}

test("a delete decision changed to keep does not run the old delete plan", () => {
  const fixture = runFixture();
  const plansDir = join(fixture.root, "plans");
  const routingPath = join(fixture.root, "routing.json");
  try {
    const firstDigest = fixture.writeDecisions({
      conversationId: "11111111-1111-4111-8111-111111111111",
      decision: "delete",
      reviewed: true,
    });
    compileReviewedDecisions(fixture.inventoryPath, fixture.decisionsPath, plansDir);
    compileProjectRouting(fixture.inventoryPath, fixture.decisionsPath, routingPath);
    const compiled = JSON.parse(readFileSync(join(plansDir, "batch-001.json"), "utf8"));
    assert.equal(compiled.actions[0].decision, "delete");

    // 적용이 실패했고 사용자가 보존으로 바꿔 다시 저장했다.
    const secondDigest = fixture.writeDecisions({
      conversationId: "11111111-1111-4111-8111-111111111111",
      decision: "keep",
      newTitle: "임시 주제 — 정리 결과",
      projectName: "조사",
      reviewed: true,
    });
    assert.notEqual(firstDigest, secondDigest);

    const reuse = planReuseDecision({
      hasCompiledArtifacts: existsSync(plansDir) || existsSync(routingPath),
      stampDigest: firstDigest,
      decisionsDigest: secondDigest,
      hasReceipts: false,
    });
    assert.equal(reuse.action, "recompile");

    rmSync(plansDir, { recursive: true, force: true });
    rmSync(routingPath, { force: true });
    compileReviewedDecisions(fixture.inventoryPath, fixture.decisionsPath, plansDir);
    compileProjectRouting(fixture.inventoryPath, fixture.decisionsPath, routingPath);

    const recompiled = JSON.parse(readFileSync(join(plansDir, "batch-001.json"), "utf8"));
    assert.equal(recompiled.actions.length, 1);
    assert.equal(recompiled.actions[0].decision, "keep");
    assert.equal(recompiled.actions[0].newTitle, "임시 주제 — 정리 결과");
    const routed = JSON.parse(readFileSync(routingPath, "utf8"))
      .targets.flatMap((target) => target.actions.map((action) => action.conversationId));
    assert.deepEqual(routed.sort(), [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a corrupted plan source file is treated as unknown origin, not a hard failure", () => {
  const root = mkdtempSync(join(tmpdir(), "maintenance-web-stamp-"));
  try {
    const stampPath = join(root, "compiled-plan-source.json");
    writeFileSync(stampPath, "{ 깨진 JSON");
    let planSource = null;
    if (existsSync(stampPath)) {
      try { planSource = JSON.parse(readFileSync(stampPath, "utf8")); } catch { planSource = null; }
    }
    assert.equal(planSource, null);
    assert.equal(planReuseDecision({
      hasCompiledArtifacts: true,
      stampDigest: planSource?.decisionsDigest || null,
      decisionsDigest: DECISIONS_DIGEST,
      hasReceipts: false,
    }).action, "recompile");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a completed run refuses another apply but a failed one can retry", () => {
  assert.throws(() => assertApplyablePhase("complete"), /이미 적용을 마쳤습니다/);
  assert.equal(assertApplyablePhase("awaiting-proposal"), true);
});
