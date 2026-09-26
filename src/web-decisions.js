// 사용자의 결정을 검증·저장하고, 삭제후보 이동과 후속 실행을 준비한다.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { PHASE } from "./phases.js";
import { basename, join } from "node:path";
import { assert } from "./assert.js";
import { runFiles } from "./run-files.js";
import { sha256 } from "./content-hash.js";
import { runsDir } from "./data-dir.js";
import { compileReviewedDecisions } from "./decision-compile.js";
import { isNormalizedTitle } from "./title-rules.js";
import { readTrash } from "./trash.js";
import { readPointer, runId, writePointer } from "./web-common.js";
import { readJson, writeJsonAtomic } from "./fs-json.js";
import { proposalData } from "./web-views.js";

// 화면에서 직접 만든 후보별 결정을 reviewed-decisions.json 형식으로 검증·변환한다.
// 규칙은 decision-compile.js compileReviewedDecisions / finalize.js finalizeMaintenanceRun과 같다.
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
    // 삭제후보으로 옮기는 대화도 표준 제목을 갖는다(살릴 수도 있고 목록 탐색에 필요하다).
    assert(isNormalizedTitle(newTitle || source.title),
      `${label}: 제목은 "주제 — 작업/결과" 형식이어야 합니다`);
    const projectName = typeof input.projectName === "string" ? input.projectName.trim() : "";
    assert(!(input.trashed === true && input.marked === true), `${label}: 삭제후보 이동과 삭제 표시는 함께 쓸 수 없습니다`);
    return {
      conversationId: source.conversationId,
      decision: "keep",
      ...(newTitle && newTitle !== source.title ? { newTitle } : {}),
      ...(input.trashed === true ? { trashed: true } : {}),
      ...(input.marked === true ? { marked: true } : {}),
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

export function writeReviewedDecisions(workspace, dataDir, inputs, trash = null) {
  const pointer = readPointer(workspace, dataDir);
  assert(pointer, "먼저 대화 확인(조사 범위 선택)을 실행하세요");
  assert(pointer.phase === PHASE.AWAITING_PROPOSAL, "지금은 결정을 받을 단계가 아닙니다");
  const inventory = readJson(pointer.inventoryPath, "인벤토리");
  const decisions = buildReviewedDecisionsFromInputs(pointer, inventory, inputs);
  writeJsonAtomic(runFiles(pointer.runDir).decisions, decisions);
  writeTrashMeta(pointer, inventory, decisions, trash);
  return { saved: decisions.decisions.length };
}

// 삭제 후보를 삭제후보 프로젝트로 보내는 결정이면, 적용이 끝난 뒤 삭제후보 목록에 남길 정보를 실행 폴더에 적어 둔다.
function writeTrashMeta(pointer, inventory, decisions, trash) {
  const path = runFiles(pointer.runDir).trashMeta;
  if (!trash) { rmSync(path, { force: true }); return; }
  assert(typeof trash.project === "string" && trash.project.trim() === trash.project && trash.project,
    "삭제후보 프로젝트 이름이 올바르지 않습니다");
  const decisionById = new Map(decisions.decisions.map((item) => [item.conversationId, item]));
  const inventoryById = new Map(inventory.conversations.map((item) => [item.conversationId, item]));
  const items = [];
  for (const entry of trash.entries || []) {
    const decision = decisionById.get(entry.conversationId);
    const source = inventoryById.get(entry.conversationId);
    assert(decision && source, "삭제후보 이동 대상이 이번 후보에 없습니다");
    assert(decision.decision === "keep" && decision.projectName === trash.project,
      "삭제후보 이동 대상은 삭제후보 프로젝트에 두는 결정이어야 합니다");
    items.push({
      conversationId: entry.conversationId, title: decision.newTitle || source.title, fromProject: source.projectName || null,
      reason: String(entry.reason || "").slice(0, 200), intendedTarget: entry.intendedTarget ?? null, record: source,
    });
  }
  writeJsonAtomic(path, { version: 1, project: trash.project, items });
}

// 삭제후보으로 옮길 때 제목을 표준화하므로, 보관 시점의 본문 사본은 지금 제목과 다를 수 있다.
// 삭제 검증은 사본의 제목이 현재 제목과 같아야 하므로, 다르면 제목만 바꾼 사본을 이 실행 폴더에 만든다
// (본문 해시 contentSha256은 mapping만 보므로 그대로다).
function backupWithCurrentTitle(record, currentTitle, runDir) {
  const original = { backupFile: record.backupFile, backupSha256: record.backupSha256, backupBytes: record.backupBytes };
  let data;
  try { data = JSON.parse(readFileSync(record.backupFile, "utf8")); } catch { return original; }
  if (data?.title === currentTitle) return original;
  const dir = join(runDir, "json");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const backupFile = join(dir, `${record.conversationId}.json`);
  const raw = Buffer.from(JSON.stringify({ ...data, title: currentTitle }, null, 2));
  writeFileSync(backupFile, raw, { mode: 0o600 });
  return { backupFile, backupSha256: sha256(raw), backupBytes: raw.length };
}

// 후속 실행(삭제후보 확정): 삭제후보 목록의 대화만 후보로 하는 작은 실행을 만든다. 기록해 둔 제목·본문 사본을 쓰므로 원격을 읽지 않는다.
// 적용할 때 각 대화의 실제 제목이 기록과 다르면(사용자가 그 사이 바꿨다면) 적용이 그 대화에서 안전하게 멈춘다.
export function prepareTrashFollowUp(workspace, dataDir, inputs) {
  const trash = readTrash(dataDir);
  assert(trash.items.length, "삭제후보 프로젝트에 옮겨 둔 대화가 없습니다");
  assert(Array.isArray(inputs) && inputs.length, "결정이 비어 있습니다");
  const trashedById = new Map(trash.items.map((item) => [item.conversationId, item]));
  const runDir = join(runsDir(dataDir), `trash-${runId()}`);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const conversations = inputs.map((input) => {
    const trashed = trashedById.get(input.conversationId);
    assert(trashed, "삭제후보 목록에 없는 대화입니다");
    const backup = backupWithCurrentTitle(trashed.record, trashed.title, runDir);
    return { ...trashed.record, title: trashed.title, projectName: trash.project, isArchived: false, reasons: ["trash-review"],
      backupFile: backup.backupFile, backupSha256: backup.backupSha256,
      backupBytes: backup.backupBytes, contentSha256: trashed.record.contentSha256,
      messageCount: trashed.record.messageCount, attachmentReferenceCount: trashed.record.attachmentReferenceCount ?? 0 };
  });
  const scope = { kind: "project", projectNames: [trash.project] };
  const catalogPath = runFiles(runDir).catalog;
  const projects = [{ projectName: trash.project, conversationCount: null, sampleTitles: [] }];
  writeJsonAtomic(catalogPath, {
    version: 1, kind: "conversation-maintenance-catalog", generatedAt: new Date().toISOString(),
    scope: { activeConversations: true, archivedConversations: false, projectDiscovery: "owned_only", complete: false, collected: scope },
    counts: { conversations: conversations.length, active: conversations.length, archived: 0, unassigned: 0, projects: 1 },
    projects,
    conversations: conversations.map((item) => ({ conversationId: item.conversationId, title: item.title, createTime: item.createTime ?? null,
      updateTime: item.updateTime ?? null, isArchived: false, projectName: trash.project })),
  });
  const inventory = {
    version: 1, kind: "conversation-maintenance-inventory", generatedAt: new Date().toISOString(), runRoot: runDir,
    catalogFile: catalogPath, source: { mode: "scope", scope },
    counts: { catalogConversations: conversations.length, candidates: conversations.length, attachmentReferences: 0 },
    warnings: [], projects, conversations,
  };
  const inventoryPath = runFiles(runDir).inventory;
  writeJsonAtomic(inventoryPath, inventory);
  const pointer = { version: 1, phase: PHASE.READY_TO_APPLY, runDir, inventoryPath, reviewPath: null,
    proposalPath: runFiles(runDir).proposal, result: { counts: { candidates: conversations.length }, warnings: [], scope } };
  const decisions = buildReviewedDecisionsFromInputs(pointer, inventory, inputs.map((input) => ({
    conversationId: input.conversationId, decision: input.decision === "delete" ? "delete" : "keep",
    projectName: input.decision === "delete" ? "" : (input.projectName || ""),
    ...(input.decision !== "delete" && input.newTitle ? { newTitle: input.newTitle } : {}),
  })));
  writeJsonAtomic(runFiles(runDir).decisions, decisions);
  writeJsonAtomic(runFiles(runDir).followUp, { version: 1, kind: "trash", project: trash.project,
    ids: conversations.map((item) => item.conversationId) });
  writePointer(workspace, pointer);
  const deletes = decisions.decisions.filter((item) => item.decision === "delete").length;
  return { runId: basename(runDir), candidates: conversations.length, deletes,
    moves: decisions.decisions.filter((item) => item.decision === "keep" && item.projectName).length };
}

export function savePastedProposal(workspace, dataDir, proposalJson) {
  const pointer = readPointer(workspace, dataDir);
  assert(pointer, "먼저 대화 확인(조사 범위 선택)을 실행하세요");
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
