// 화면이 읽는 데이터(세션·요약·보고서·분류안·카탈로그). 읽기 전용이다.
import { existsSync } from "node:fs";
import { runFiles } from "./run-files.js";
import { basename, join } from "node:path";
import { lockStatus } from "./maintenance-lock.js";
import { relayBroker } from "./remote-relay.js";
import { buildClaudePrompt } from "./classification-review.js";
import { CLASSIFICATION_CRITERIA } from "./classification-criteria.js";
import { validateClassificationProposals } from "./proposal-validation.js";
import { readTrash } from "./trash.js";
import { findPartialScan } from "./scan.js";
import { readKnownProjects } from "./known-projects.js";
import { deriveStep, describeRelay } from "./session.js";
import { APP_ROOT, publicPointer, readPointer } from "./web-common.js";
import { appStatus } from "./app-status.js";
import { readJson } from "./fs-json.js";
import { jobLogFor, jobs, publicJob } from "./web-jobs.js";

// 삭제후보 프로젝트에 옮겨 둔 대화 현황: 프로젝트 이름, 건수, 가장 오래 둔 대화의 경과 일수.
function trashSummary(dataDir, nowMs = Date.now()) {
  const trash = readTrash(dataDir);
  const times = trash.items.map((item) => Date.parse(item.trashedAt || "")).filter(Number.isFinite);
  return {
    project: trash.project, count: trash.items.length,
    oldestDays: times.length ? Math.floor((nowMs - Math.min(...times)) / 86400000) : null,
  };
}

// 화면 첫 진입에 필요한 모든 상태를 한 번에 준다: 연결, 알려진 프로젝트, 삭제후보 현황, 현재 실행, 작업, 단계.
export function sessionData(workspace, dataDir) {
  const pointer = readPointer(workspace, dataDir);
  const relay = relayBroker.status();
  const active = [...jobs.values()].filter((job) => job.workspace === workspace && !job.done);
  const activeJob = active[0] ? publicJob(active[0]) : null;
  const recent = jobLogFor(dataDir).recent(3);
  let run = null;
  if (pointer) {
    const proposalPath = pointer.proposalPath || runFiles(pointer.runDir).proposal;
    run = {
      id: basename(pointer.runDir), phase: pointer.phase || "unknown", updatedAt: pointer.updatedAt || null,
      candidates: pointer.result?.counts?.candidates ?? null,
      scope: pointer.result?.scope || null,
      skipped: pointer.result?.skipped || [],
      standardTitlesExcluded: pointer.result?.standardTitlesExcluded || 0,
      hasProposal: existsSync(proposalPath),
      hasDecisions: existsSync(runFiles(pointer.runDir).decisions),
      hasReport: existsSync(runFiles(pointer.runDir).report),
    };
  }
  let report = null;
  if (run?.hasReport) {
    try { const data = readJson(runFiles(pointer.runDir).report, "결과"); report = { headline: data.headline, finishedAt: data.finishedAt }; } catch {}
  }
  // 결과 보고서 뒤에 끝난 읽기 전용 작업(scan 종류: 확인·삭제후보 다시 확인)이 있으면 결과 화면으로 되돌리지 않는다.
  const reportAt = Date.parse(report?.finishedAt || "") || 0;
  const resultSuperseded = jobLogFor(dataDir).recent(10).some((job) => job.kind === "scan" && job.ok && Date.parse(job.finishedAt || "") > reportAt);
  const lock = lockStatus({ dataDir });
  return {
    relay: { ...relay, ...describeRelay(relay) },
    app: appStatus(APP_ROOT),
    knownProjects: readKnownProjects(dataDir),
    trash: trashSummary(dataDir),
    run,
    // 끊긴 수집에서 받아 둔 본문이 있으면 그것만으로 분류를 진행할 수 있다(진행 중인 작업이 없을 때만 알린다).
    partialScan: activeJob ? null : (() => {
      const found = findPartialScan(dataDir);
      return found ? { scope: found.scope, downloaded: found.downloaded, total: found.total } : null;
    })(),
    report,
    step: deriveStep({ activeJobKind: activeJob?.kind || null, phase: run?.phase, hasProposal: run?.hasProposal,
      hasReport: run?.hasReport, hasRun: Boolean(run), resultSuperseded }),
    job: activeJob,
    recentJobs: recent,
    lock: lock.locked ? { device: lock.holder?.device || null, stale: lock.stale } : null,
  };
}

export function reportData(workspace, dataDir) {
  const pointer = readPointer(workspace, dataDir);
  const path = pointer ? runFiles(pointer.runDir).report : null;
  if (!path || !existsSync(path)) return { ready: false };
  return { ready: true, report: readJson(path, "결과 보고서") };
}

export function proposalData(workspace, dataDir) {
  const pointer = readPointer(workspace, dataDir);
  if (!pointer) return { ready: false, run: null };
  const proposalPath = pointer.proposalPath || runFiles(pointer.runDir).proposal;
  if (!existsSync(proposalPath)) {
    return {
      ready: false,
      run: publicPointer(pointer),
      prompt: classificationPrompt(pointer),
      claudePrompt: claudePrompt(pointer),
    };
  }
  const validation = validateClassificationProposals(pointer.inventoryPath, proposalPath);
  const proposal = readJson(proposalPath, "분류안");
  const manualMoves = proposal.items.filter((item) => item.suggestedProjectAction === "manual-move").length;
  return {
    ready: true,
    run: publicPointer(pointer),
    validation,
    items: proposal.items,
    prompt: classificationPrompt(pointer),
    claudePrompt: claudePrompt(pointer),
    blockers: {
      undecided: validation.decisionCounts.undecided,
      manualMoves,
    },
  };
}

// 파일 접근이 가능한 에이전트(같은 저장소의 Codex/Claude Code)용. 규칙 문서를
// 통째로 읽게 하지 않고 압축 기준을 프롬프트에 바로 넣는다.
function classificationPrompt(pointer) {
  const proposalPath = pointer.proposalPath || runFiles(pointer.runDir).proposal;
  return [
    "이 작업공간에서 ChatGPT 대화 유지관리의 '분류' 단계를 수행해줘. 분류만 하고 승인 파일·실행 계획·원격 변경은 만들거나 실행하지 마.",
    "판단 기준은 아래에 모두 있으니 저장소 문서를 따로 읽지 않아도 돼.",
    "",
    `인벤토리: ${pointer.inventoryPath}`,
    `분류용 최소 입력(발췌): ${pointer.reviewPath}`,
    `결과 파일: ${proposalPath}`,
    "",
    "## 판단 기준",
    ...CLASSIFICATION_CRITERIA.map((line) => `- ${line}`),
    "",
    "review.json의 후보 전체만 분류하고, 첨부·비텍스트 때문에 불분명한 항목만 원본 JSON을 추가 확인해.",
    "모든 후보에 보존·삭제·미결정, 표준 제목(null 가능), 최종 프로젝트, 프로젝트 조치, 확신도, 근거를 제안해 proposal.json으로 저장해.",
    `저장 후 node workflow.js validate-proposal "${pointer.inventoryPath}" "${proposalPath}" 로 검증하고, 결과 JSON 전문을 답변에도 붙여줘 — 유지관리 앱의 '분류 결과 JSON 붙여넣기' 칸에 넣을 수 있게.`,
  ].join("\n");
}

// claude.ai 등 파일 접근이 없는 곳에 그대로 붙여넣을 자립형 요청문.
function claudePrompt(pointer) {
  if (!pointer.reviewPath || !existsSync(pointer.reviewPath)) return null;
  try {
    return buildClaudePrompt(readJson(pointer.reviewPath, "분류용 입력"), {
      inventoryPath: pointer.inventoryPath,
      proposalPath: pointer.proposalPath || runFiles(pointer.runDir).proposal,
    });
  } catch { return null; }
}

// 이번 실행의 catalog.json에서 대화 목록을 만든다. 화면의 검색·필터·정렬은 클라이언트가 처리한다.
export function catalogData(workspace, dataDir) {
  const pointer = readPointer(workspace, dataDir);
  const runCatalogPath = pointer ? runFiles(pointer.runDir).catalog : null;
  if (!runCatalogPath || !existsSync(runCatalogPath)) return { ready: false };
  const catalog = readJson(runCatalogPath, "카탈로그");

  const reasonsById = new Map();
  if (existsSync(pointer.inventoryPath)) {
    const inventory = readJson(pointer.inventoryPath, "인벤토리");
    for (const item of inventory.conversations || []) {
      reasonsById.set(item.conversationId, item.reasons || []);
    }
  }

  const conversations = (catalog.conversations || []).map((item) => ({
    conversationId: item.conversationId,
    title: item.title,
    projectName: item.projectName || null,
    createTime: item.createTime ?? null,
    updateTime: item.updateTime ?? null,
    isArchived: item.isArchived === true,
    reasons: reasonsById.get(item.conversationId) || [],
  }));

  return {
    ready: true,
    scope: catalog.scope || null,
    generatedAt: catalog.generatedAt || null,
    counts: {
      conversations: conversations.length,
      unassigned: conversations.filter((item) => !item.projectName).length,
      archived: conversations.filter((item) => item.isArchived).length,
      candidates: reasonsById.size,
      projects: (catalog.projects || []).length,
    },
    projects: (catalog.projects || []).map((project) => ({
      projectName: project.projectName,
      conversationCount: project.conversationCount ?? null,
    })),
    currentRun: pointer ? publicPointer(pointer) : null,
    conversations,
  };
}
