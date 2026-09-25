// 사용자의 결정을 검증·저장하고, 임시 보관과 후속 실행을 준비한다.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { PHASE } from "./phases.js";
import { basename, join } from "node:path";
import { assert } from "./assert.js";
import { runFiles } from "./run-files.js";
import { sha256 } from "./content-hash.js";
import { runsDir, stateFilePath } from "./data-dir.js";
import { compileReviewedDecisions } from "./decision-compile.js";
import { isNormalizedTitle } from "./title-rules.js";
import { readParking } from "./parking.js";
import { publicPointer, readPointer, runId, writePointer } from "./web-common.js";
import { readJson, writeJsonAtomic } from "./fs-json.js";
import { proposalData, reviewedDecisionsSummary } from "./web-views.js";

// 화면에서 직접 만든 후보별 결정을 reviewed-decisions.json 형식으로 검증·변환한다.
// 규칙은 decision-compile.js compileReviewedDecisions / checkpoint.js checkpointMaintenanceRun과 같다.
export function buildReviewedDecisionsFromInputs(pointer, inventory, inputs) {
  assert(inventory?.version === 1 && inventory.kind === "conversation-maintenance-inventory",
    "유지관리 인벤토리가 아닙니다");
  assert(Array.isArray(inventory.warnings) && inventory.warnings.length === 0,
    `인벤토리에 경고가 있어 결정을 만들 수 없습니다: ${(inventory.warnings || ["warnings 필드 없음"]).join("; ")}`);
  assert(Array.isArray(inputs) && inputs.length > 0, "결정이 비어 있습니다");
  const inventoryById = new Map(inventory.conversations.map((item) => [item.conversationId, item]));
  const seen = new Set();
  const decisions = inputs.map((input, index) => {
    const label = `결정[${index}]`;
    assert(input && typeof input === "object" && !Array.isArray(input), `${label} 형식이 올바르지 않습니다`);
    const source = inventoryById.get(input.conversationId);
    assert(source, `${label}: 인벤토리에 없는 대화입니다`);
    assert(!seen.has(input.conversationId), `${label}: 중복된 대화입니다`);
    seen.add(input.conversationId);
    assert(input.decision === "keep" || input.decision === "delete",
      `${label}: 결정은 보존 또는 삭제여야 합니다`);
    const newTitle = typeof input.newTitle === "string" ? input.newTitle.trim() : "";
    if (input.decision === "delete") {
      assert(!newTitle, `${label}: 삭제할 대화의 제목은 바꿀 수 없습니다`);
      return { conversationId: source.conversationId, decision: "delete", reviewed: true };
    }
    // 임시 보관 대상은 표준 제목 규칙에서 제외한다(곧 삭제되거나, 남길 때 새 제목을 받는다).
    assert(input.parked === true || isNormalizedTitle(newTitle || source.title),
      `${label}: 제목은 "주제 — 작업/결과" 형식이어야 합니다`);
    const projectName = typeof input.projectName === "string" ? input.projectName.trim() : "";
    return {
      conversationId: source.conversationId,
      decision: "keep",
      ...(newTitle && newTitle !== source.title ? { newTitle } : {}),
      ...(input.parked === true ? { parked: true } : {}),
      projectName: projectName || null,
      reviewed: true,
    };
  });
  assert(seen.size === inventoryById.size, "모든 후보에 정확히 하나의 결정이 필요합니다");
  return {
    version: 1,
    kind: "reviewed-decisions",
    inventoryDigest: sha256(readFileSync(pointer.inventoryPath)),
    receiptDir: runFiles(pointer.runDir).receipts,
    decisions,
  };
}

export function writeReviewedDecisions(workspace, dataDir, inputs, parking = null) {
  const pointer = readPointer(workspace, dataDir);
  assert(pointer, "먼저 새 대화 확인을 실행하세요");
  assert(pointer.phase === PHASE.AWAITING_PROPOSAL, "지금은 결정을 받을 단계가 아닙니다");
  const inventory = readJson(pointer.inventoryPath, "인벤토리");
  const decisions = buildReviewedDecisionsFromInputs(pointer, inventory, inputs);
  writeJsonAtomic(runFiles(pointer.runDir).decisions, decisions);
  writeParkingMeta(pointer, inventory, decisions, parking);
  return {
    ready: true,
    run: publicPointer(pointer),
    ...reviewedDecisionsSummary(inventory, decisions),
    decisions: decisions.decisions,
  };
}

// 삭제 후보를 임시 보관 프로젝트로 보내는 결정이면, 적용이 끝난 뒤 보관 목록에 남길 정보를 실행 폴더에 적어 둔다.
function writeParkingMeta(pointer, inventory, decisions, parking) {
  const path = runFiles(pointer.runDir).parkingMeta;
  if (!parking) { rmSync(path, { force: true }); return; }
  assert(typeof parking.project === "string" && parking.project.trim() === parking.project && parking.project,
    "임시 보관 프로젝트 이름이 올바르지 않습니다");
  const decisionById = new Map(decisions.decisions.map((item) => [item.conversationId, item]));
  const inventoryById = new Map(inventory.conversations.map((item) => [item.conversationId, item]));
  const items = [];
  for (const entry of parking.entries || []) {
    const decision = decisionById.get(entry.conversationId);
    const source = inventoryById.get(entry.conversationId);
    assert(decision && source, "임시 보관 대상이 이번 후보에 없습니다");
    assert(decision.decision === "keep" && decision.projectName === parking.project,
      "임시 보관 대상은 보관 프로젝트에 두는 결정이어야 합니다");
    items.push({
      conversationId: entry.conversationId, title: decision.newTitle || source.title, fromProject: source.projectName || null,
      reason: String(entry.reason || "").slice(0, 200), intendedTarget: entry.intendedTarget ?? null, record: source,
    });
  }
  writeJsonAtomic(path, { version: 1, project: parking.project, items });
}

// 후속 실행(검토 대기 확정): 보관 목록의 대화만 후보로 하는 작은 실행을 만든다.
export function prepareParkingFollowUp(workspace, dataDir, inputs) {
  const parking = readParking(dataDir);
  assert(parking.items.length, "검토 대기 중인 대화가 없습니다");
  assert(Array.isArray(inputs) && inputs.length, "결정이 비어 있습니다");
  const parkedById = new Map(parking.items.map((item) => [item.conversationId, item]));
  const statePath = stateFilePath(dataDir);
  const stateRaw = readFileSync(statePath);
  const state = JSON.parse(stateRaw.toString("utf8"));
  const stateById = new Map(state.conversations.map((item) => [item.conversationId, item]));
  const conversations = inputs.map((input) => {
    const parked = parkedById.get(input.conversationId);
    assert(parked, "검토 대기 목록에 없는 대화입니다");
    const current = stateById.get(input.conversationId);
    assert(current, `기준선에 없는 대화입니다(이미 삭제됐으면 고급 메뉴의 ‘ChatGPT 상태 다시 맞추기’로 기록을 갱신하세요): ${parked.title}`);
    return { ...parked.record, ...current, reasons: ["parking-review"],
      backupFile: parked.record.backupFile, backupSha256: parked.record.backupSha256,
      backupBytes: parked.record.backupBytes, contentSha256: parked.record.contentSha256,
      messageCount: parked.record.messageCount, attachmentReferenceCount: parked.record.attachmentReferenceCount ?? 0 };
  });
  const runDir = join(runsDir(dataDir), `parking-${runId()}`);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const catalogPath = runFiles(runDir).catalog;
  writeJsonAtomic(catalogPath, { ...state, kind: "conversation-maintenance-catalog" });
  const inventory = {
    version: 1, kind: "conversation-maintenance-inventory", generatedAt: new Date().toISOString(), runRoot: runDir,
    catalogFile: catalogPath, source: { mode: "followup", stateDigest: sha256(stateRaw) },
    counts: { catalogConversations: state.conversations.length, candidates: conversations.length, removed: 0, confirmedUnavailable: 0,
      held: 0, attachmentReferences: 0 },
    warnings: [], removedConversationIds: [], confirmedUnavailableConversationIds: [], heldConversationIds: [],
    projects: state.projects, conversations,
  };
  const inventoryPath = runFiles(runDir).inventory;
  writeJsonAtomic(inventoryPath, inventory);
  const pointer = { version: 1, phase: PHASE.READY_TO_APPLY, runDir, inventoryPath, reviewPath: null,
    proposalPath: runFiles(runDir).proposal, result: { counts: { candidates: conversations.length }, warnings: [] } };
  const decisions = buildReviewedDecisionsFromInputs(pointer, inventory, inputs.map((input) => ({
    conversationId: input.conversationId, decision: input.decision === "delete" ? "delete" : "keep",
    projectName: input.decision === "delete" ? "" : (input.projectName || ""),
    ...(input.decision !== "delete" && input.newTitle ? { newTitle: input.newTitle } : {}),
  })));
  writeJsonAtomic(runFiles(runDir).decisions, decisions);
  writeJsonAtomic(runFiles(runDir).followUp, { version: 1, kind: "parking", project: parking.project,
    ids: conversations.map((item) => item.conversationId) });
  writePointer(workspace, pointer);
  const deletes = decisions.decisions.filter((item) => item.decision === "delete").length;
  return { runId: basename(runDir), candidates: conversations.length, deletes,
    moves: decisions.decisions.filter((item) => item.decision === "keep" && item.projectName).length };
}

export function savePastedProposal(workspace, dataDir, proposalJson) {
  const pointer = readPointer(workspace, dataDir);
  assert(pointer, "먼저 새 대화 확인을 실행하세요");
  assert(pointer.phase === PHASE.AWAITING_PROPOSAL, "지금은 분류안을 받을 단계가 아닙니다");
  assert(pointer.reviewPath, "이 실행에는 분류할 후보가 없습니다");
  let parsed;
  try { parsed = JSON.parse(typeof proposalJson === "string" ? proposalJson : ""); }
  catch { throw new Error("붙여넣은 분류안이 올바른 JSON이 아닙니다"); }
  assert(parsed && typeof parsed === "object" && !Array.isArray(parsed),
    "붙여넣은 분류안 형식이 올바르지 않습니다");
  const proposalPath = pointer.proposalPath || runFiles(pointer.runDir).proposal;
  writeJsonAtomic(proposalPath, parsed);
  return proposalData(workspace, dataDir);
}

export function buildReviewedDecisions(pointer, proposal) {
  return {
    version: 1,
    kind: "reviewed-decisions",
    inventoryDigest: proposal.inventoryDigest,
    receiptDir: runFiles(pointer.runDir).receipts,
    decisions: proposal.items.map((item) => {
      assert(item.suggestedDecision !== "undecided", "undecided 항목은 승인 전에 해결해야 합니다");
      if (item.suggestedDecision === "delete") {
        return {
          conversationId: item.conversationId,
          decision: "delete",
          reviewed: true,
          rationale: item.rationale,
        };
      }
      return {
        conversationId: item.conversationId,
        decision: "keep",
        ...(item.suggestedNewTitle ? { newTitle: item.suggestedNewTitle } : {}),
        projectName: item.suggestedProjectName ?? null,
        reviewed: true,
        rationale: item.rationale,
      };
    }),
  };
}
