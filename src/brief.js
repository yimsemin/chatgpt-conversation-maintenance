#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { PHASE } from "./phases.js";
import { runFiles } from "./run-files.js";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDataDir } from "./data-dir.js";
import { lockStatus } from "./maintenance-lock.js";
import { readTrash } from "./trash.js";

// 새 대화(에이전트)가 코드를 탐색하지 않고 현재 상태와 다음 할 일을 바로
// 알도록 하는 읽기 전용 요약이다. ChatGPT에 요청하지 않고 파일만 읽는다.

function readJsonOrNull(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}

function countFiles(dir) {
  try { return readdirSync(dir).filter((name) => name.endsWith(".json")).length; }
  catch { return 0; }
}

function describeRun(pointer) {
  if (!pointer || typeof pointer.runDir !== "string") return null;
  const runDir = pointer.runDir;
  const inventory = readJsonOrNull(runFiles(runDir).inventory);
  return {
    runId: basename(runDir),
    phase: pointer.phase || "unknown",
    updatedAt: pointer.updatedAt || null,
    candidates: inventory?.counts?.candidates ?? null,
    scope: inventory?.source?.scope || null,
    hasReview: existsSync(runFiles(runDir).review),
    reviewPath: runFiles(runDir).review,
    inventoryPath: runFiles(runDir).inventory,
    promptPath: runFiles(runDir).prompt,
    hasProposal: existsSync(runFiles(runDir).proposal),
    proposalPath: runFiles(runDir).proposal,
    hasDecisions: existsSync(runFiles(runDir).decisions),
    receipts: countFiles(runFiles(runDir).receipts),
    result: pointer.result || null,
  };
}

// 사용자가 버튼으로 하는 일과 에이전트가 하는 일을 구분해 다음 행동 하나만 돌려준다.
export function nextAction({ lock, run }) {
  if (lock?.locked && !lock.stale) {
    return { actor: "user", text: "다른 실행이 잠금을 잡고 있다. 그 실행이 끝났는지 확인 후 node maintenance-lock.js release" };
  }
  if (!run || run.phase === PHASE.COMPLETE) {
    return { actor: "user", text: "화면에서 수집 범위를 고르고 '이 범위 수집'을 누른다(에이전트는 스캔하지 않는다)" };
  }
  if (run.phase === PHASE.READY_TO_APPLY) {
    return { actor: "user", text: "화면에서 검토가 끝난 결정의 '적용 시작'을 누른다" };
  }
  if (run.phase === PHASE.AWAITING_PROPOSAL && !run.hasProposal) {
    return {
      actor: "agent",
      text: `AI 분류: node workflow.js claude-prompt "${run.reviewPath}" "${run.promptPath}" "${run.inventoryPath}" "${run.proposalPath}" 로 요청문을 만들고, 그 지시대로 proposal.json 을 쓴 뒤 validate-proposal 로 검증한다`,
    };
  }
  if (run.hasProposal && !run.hasDecisions) {
    return { actor: "user", text: "화면에서 제안을 불러와 검토·수정한 뒤 '결정 저장 및 적용'을 누른다" };
  }
  return { actor: "user", text: "화면에서 결정을 확인하고 '결정 저장 및 적용'을 누른다" };
}

export function buildBrief({ appRoot, dataDir = "", now = () => Date.now() } = {}) {
  const resolvedRoot = resolve(appRoot);
  const dir = resolveDataDir({ dataDir, appRoot: resolvedRoot });
  const lock = lockStatus({ dataDir: dir, now });
  const pointer = readJsonOrNull(join(resolvedRoot, ".local", "maintenance-web.json"));
  const run = pointer?.version === 1 && pointer.result?.scope ? describeRun(pointer) : null;
  const trash = readTrash(dir);
  return {
    lock: lock.locked ? { device: lock.holder?.device || null, stale: lock.stale } : null,
    run,
    trash: trash.items.length ? { project: trash.project, count: trash.items.length } : null,
    next: nextAction({ lock, run }),
  };
}

export function formatBrief(brief) {
  const lines = [];
  lines.push(`잠금: ${brief.lock ? `${brief.lock.device || "unknown"}${brief.lock.stale ? " (오래됨)" : ""}` : "없음"}`);
  if (brief.run) {
    const r = brief.run;
    const scope = r.scope ? ` · 범위 ${r.scope.kind === "project" ? `프로젝트 ${(r.scope.projectNames || [r.scope.projectName]).join(", ")}` : r.scope.kind === "recent" ? `최근 ${r.scope.days}일` : r.scope.kind === "untidy" ? "미정돈" : r.scope.kind === "all" ? "전체" : "프로젝트 없는 대화"}` : "";
    lines.push(
      `최근 실행: ${r.runId} · ${r.phase}${scope} · 후보 ${r.candidates ?? "?"}건`
      + ` · 분류안 ${r.hasProposal ? "있음" : "없음"} · 결정 ${r.hasDecisions ? "있음" : "없음"} · 영수증 ${r.receipts}건`,
    );
  } else {
    lines.push("최근 실행: 없음");
  }
  if (brief.trash) lines.push(`삭제후보: ${brief.trash.count}건 (ChatGPT 프로젝트 「${brief.trash.project}」) — 화면의 '삭제후보 확인'에서 사용자가 확정한다`);
  lines.push(`다음: [${brief.next.actor === "agent" ? "에이전트" : "사용자"}] ${brief.next.text}`);
  return lines.join("\n");
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const appRoot = fileURLToPath(new URL("..", import.meta.url));
  const brief = buildBrief({ appRoot });
  console.log(process.argv.includes("--json") ? JSON.stringify(brief, null, 2) : formatBrief(brief));
}
