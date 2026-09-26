// 원격에 닿는 워크플로: 스캔, 기준선 확정, 적용. 잠금·영수증·체크포인트를 다룬다.
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { PHASE } from "./phases.js";
import { join } from "node:path";
import { assert } from "./assert.js";
import { runFiles } from "./run-files.js";
import { sha256 } from "./content-hash.js";
import { runsDir } from "./data-dir.js";
import { acquireLock, releaseLock } from "./maintenance-lock.js";
import { applyPlanSet, preparePlanSet } from "./plan-set.js";
import { finalizeMaintenanceRun } from "./finalize.js";
import { describeScope, scanMaintenanceRun, validateScope } from "./scan.js";
import { prepareProjectRouting, projectRoutingStatus, runProjectRouting, validateProjectRouting } from "./project-routing.js";
import { compileProjectRouting, compileReviewedDecisions } from "./decision-compile.js";
import { writeClassificationReview } from "./classification-review.js";
import { addTrashed, readTrash, removeTrashed } from "./trash.js";
import { collectScopedCatalog, listProjectNames } from "./catalog.js";
import { writeKnownProjects } from "./known-projects.js";
import { buildResultReport, reportMarkdown, rowsFromDecisions } from "./summary.js";
import { publicPointer, readPointer, runId, writePointer } from "./web-common.js";
import { readJson, writeJsonAtomic } from "./fs-json.js";
import { jobEvent, reportProgress, untilDone } from "./web-jobs.js";
import { proposalData } from "./web-views.js";
import { buildReviewedDecisions } from "./web-decisions.js";

// 전수 수집은 도중에 끊겨도 이어받도록 인벤토리가 없는 overhaul- 실행 폴더를 재사용한다.
function overhaulRunDir(dataDir) {
  const root = runsDir(dataDir);
  const open = existsSync(root)
    ? readdirSync(root).filter((name) => name.startsWith("overhaul-")
      && !existsSync(runFiles(join(root, name)).inventory)).sort().pop()
    : null;
  return join(root, open || `overhaul-${runId()}`);
}

export async function scanWorkflow(workspace, dataDir, api, job, { scope }) {
  const validScope = validateScope(scope);
  let lockHeld = false;
  try {
    jobEvent(job, "lock", "로컬 유지관리 잠금을 획득합니다.");
    acquireLock({ dataDir });
    lockHeld = true;
    const id = runId();
    // 전체 범위는 도중에 끊겨도 이어받도록 인벤토리가 없는 overhaul- 실행 폴더를 재사용한다.
    const runDir = validScope.kind === "all" ? overhaulRunDir(dataDir) : join(runsDir(dataDir), id);
    const inventoryPath = runFiles(runDir).inventory;
    const reviewPath = runFiles(runDir).review;
    jobEvent(job, "scan", validScope.kind === "all"
      ? "전체 조사: 모든 대화 본문을 받습니다. 이미 받은 것은 건너뜁니다(읽기 전용)."
      : `대화 확인: ${describeScope(validScope)}를 후보로 받습니다(읽기 전용).`);
    // 연결이 잠시 끊기거나 429 가 나도 같은 실행 폴더에서 이어 간다(받은 본문은 다시 받지 않는다).
    const scanResult = await untilDone(job, "확인", () => scanMaintenanceRun({
      runDir, api, scope: validScope, onProgress: (info) => reportProgress(job, info),
    }));
    writeKnownProjects(dataDir, scanResult.catalog.projects.map((project) => project.projectName));
    const counts = scanResult.inventory.counts;
    const candidateCount = Number(counts?.candidates || 0);
    const pointer = {
      phase: candidateCount > 0 ? PHASE.AWAITING_PROPOSAL : PHASE.COMPLETE,
      runDir,
      inventoryPath,
      reviewPath: candidateCount > 0 ? reviewPath : null,
      proposalPath: runFiles(runDir).proposal,
      result: { counts, warnings: scanResult.inventory.warnings || [], scope: validScope },
    };
    if (candidateCount > 0) {
      jobEvent(job, "review", "AI가 읽을 최소 분류 입력을 만듭니다.");
      writeClassificationReview(inventoryPath, reviewPath);
      writePointer(workspace, pointer);
      job.result = { phase: PHASE.AWAITING_PROPOSAL, run: publicPointer({ ...pointer, updatedAt: new Date().toISOString() }) };
      jobEvent(job, "ready", `${candidateCount}개 후보의 분류 요청 준비가 끝났습니다.`);
      return;
    }
    writePointer(workspace, pointer);
    jobEvent(job, "complete", "이 범위에는 정리할 대화가 없습니다.");
    job.result = { phase: PHASE.COMPLETE, run: publicPointer({ ...pointer, updatedAt: new Date().toISOString() }) };
  } finally {
    if (lockHeld) releaseLock({ dataDir });
  }
}

// 적용이 끝난 뒤 검토 대기 목록을 맞춘다: 새로 보관한 대화를 더하고, 후속 실행으로 처리한 대화를 뺀다.
// 후속 실행에서 삭제하거나 되돌린 대화는 이번 결과 카탈로그에서 보관 프로젝트에 남아 있지 않다.
function settleTrash(pointer, dataDir, afterCatalog) {
  const metaPath = runFiles(pointer.runDir).trashMeta;
  if (existsSync(metaPath)) {
    const meta = readJson(metaPath, "임시 보관 정보");
    addTrashed(dataDir, { project: meta.project, items: meta.items });
  }
  const followPath = runFiles(pointer.runDir).followUp;
  if (existsSync(followPath)) {
    const follow = readJson(followPath, "후속 실행 정보");
    const stillTrashed = new Set(afterCatalog.conversations.filter((item) => item.projectName === follow.project).map((item) => item.conversationId));
    removeTrashed(dataDir, follow.ids.filter((id) => !stillTrashed.has(id)));
  }
}

function writeResultReport(pointer, afterCatalog, renameOrder) {
  const inventory = readJson(pointer.inventoryPath, "인벤토리");
  const catalogBefore = readJson(inventory.catalogFile, "카탈로그");
  const decisions = readJson(runFiles(pointer.runDir).decisions, "검토된 결정");
  const report = buildResultReport({
    catalogBefore,
    catalogAfter: afterCatalog,
    rows: rowsFromDecisions(decisions, inventory),
    renameOrder,
  });
  writeJsonAtomic(runFiles(pointer.runDir).report, report);
  writeFileSync(runFiles(pointer.runDir).reportMarkdown, reportMarkdown(report), { mode: 0o600 });
  return report;
}

const PLAN_HALT_MESSAGES = {
  "changed-after-apply": "이미 적용한 결과(영수증)가 있는데 결정이 바뀌었습니다. "
    + "이 실행의 계획은 안전하게 다시 만들 수 없으므로 여기서 멈춥니다. "
    + "‘새 대화 확인’으로 현재 ChatGPT 상태를 다시 확인한 뒤 새 실행에서 결정하세요.",
  "unknown-source-after-apply": "이 실행의 계획이 어떤 결정에서 나왔는지 확인할 수 없고 적용 결과(영수증)도 있습니다. "
    + "안전을 위해 멈춥니다. ‘새 대화 확인’으로 다시 확인한 뒤 새 실행에서 결정하세요.",
};

// 이미 컴파일된 plans/·routing.json 을 지금의 승인(reviewed-decisions.json)에 그대로 써도 되는지 판정한다.
// 결정이 바뀐 뒤 옛 계획을 재사용하면 보존으로 바꾼 대화가 삭제될 수 있고,
// 이미 원격에 적용한 결과가 있으면 계획을 다시 만드는 것도 안전하지 않다.
export function planReuseDecision({ hasCompiledArtifacts, stampDigest, decisionsDigest, hasReceipts }) {
  if (!hasCompiledArtifacts) return { action: "compile", reason: "none" };
  if (stampDigest && stampDigest === decisionsDigest) return { action: "reuse", reason: "match" };
  const reason = stampDigest ? "changed" : "unknown-source";
  if (hasReceipts) return { action: "halt", reason: `${reason}-after-apply` };
  return { action: "recompile", reason };
}

// 이미 적용을 마친 실행은 다시 적용하지 않는다. 적용에 실패하면 phase 는 awaiting-proposal
// 로 남으므로 정상적인 재시도는 그대로 통과한다.
export function assertApplyablePhase(phase) {
  assert(phase !== PHASE.COMPLETE,
    "이 실행은 이미 적용을 마쳤습니다. 새 변경은 ‘새 대화 확인’으로 다시 확인한 뒤 결정하세요.");
  return true;
}

function receiptFileCount(receiptDir) {
  if (!existsSync(receiptDir)) return 0;
  return readdirSync(receiptDir).filter((name) => name.toLowerCase().endsWith(".json")).length;
}

// ---- 적용 ----
// applyWorkflow 는 아래 단계를 순서대로 부르는 조정자다. 각 단계는 ctx(작업 폴더·실행·API·작업)만 알면 되고
// 서로의 내부를 모른다. 단계 사이의 값은 반환값으로만 넘긴다.

// 적용 전 점검: 현재 실행이 적용 가능하고, 삭제가 있으면 사용자 확인이 있는지. 삭제 수와 결정 수를 돌려준다.
function checkApplyPreconditions({ workspace, dataDir, pointer, files, confirmDeletes }) {
  assert(pointer, "적용할 현재 실행이 없습니다");
  assertApplyablePhase(pointer.phase);
  let deletes;
  let decisionCount;
  // 화면에서 저장한 결정이 있으면 그것을 그대로 쓰고, 없으면 붙여넣은 proposal.json에서 만든다.
  if (existsSync(files.decisions)) {
    const reviewed = readJson(files.decisions, "검토된 결정");
    assert(reviewed?.version === 1 && reviewed.kind === "reviewed-decisions"
      && Array.isArray(reviewed.decisions), "reviewed-decisions.json 형식이 올바르지 않습니다");
    deletes = reviewed.decisions.filter((item) => item.decision === "delete").length;
    decisionCount = reviewed.decisions.length;
  } else {
    const proposal = proposalData(workspace, dataDir);
    assert(proposal.ready, "화면에서 결정을 저장하거나 proposal.json을 붙여넣으세요");
    assert(proposal.blockers.undecided === 0, "undecided 항목은 승인 전에 해결해야 합니다");
    deletes = proposal.items.filter((item) => item.suggestedDecision === "delete").length;
    decisionCount = proposal.items.length;
  }
  assert(deletes === 0 || confirmDeletes === true, `${deletes}개 삭제 후보에 대한 별도 확인이 필요합니다`);
  return { deletes, decisionCount };
}

// 승인된 결정을 실행 계획(제목·삭제 배치, 프로젝트 배치)으로 컴파일한다. 이미 컴파일된 계획은 같은 결정에서
// 나왔을 때만 재사용하고, 어긋나면 적용 결과(영수증)가 없을 때만 다시 만든다.
function compilePlans({ pointer, files, job }) {
  if (!existsSync(files.decisions)) {
    writeJsonAtomic(files.decisions, buildReviewedDecisions(pointer, readJson(pointer.proposalPath, "분류안")));
  }
  const decisionsDigest = sha256(readFileSync(files.decisions));
  // 출처 파일이 깨졌으면 출처를 모르는 계획으로 취급한다(영수증이 있으면 아래에서 중단한다).
  let planSource = null;
  if (existsSync(files.planSource)) {
    try { planSource = readJson(files.planSource, "계획 출처"); } catch { planSource = null; }
  }
  const reuse = planReuseDecision({
    hasCompiledArtifacts: existsSync(files.plans) || existsSync(files.routing),
    stampDigest: planSource?.decisionsDigest || null,
    decisionsDigest,
    hasReceipts: receiptFileCount(files.receipts) > 0,
  });
  assert(reuse.action !== "halt", PLAN_HALT_MESSAGES[reuse.reason]);
  if (reuse.action === "recompile") {
    jobEvent(job, "compile", "결정이 바뀌어 아직 적용되지 않은 이전 계획을 버리고 다시 만듭니다.");
    rmSync(files.plans, { recursive: true, force: true });
    rmSync(files.routing, { force: true });
  }

  jobEvent(job, "compile", "승인된 제목·삭제·프로젝트 계획을 컴파일합니다.");
  if (!existsSync(files.plans)) compileReviewedDecisions(pointer.inventoryPath, files.decisions, files.plans);
  const routingRequired = existsSync(files.routing)
    ? true
    : compileProjectRouting(pointer.inventoryPath, files.decisions, files.routing).routingRequired;
  if (reuse.action !== "reuse") {
    writeJsonAtomic(files.planSource, { version: 1, kind: "compiled-plan-source", decisionsDigest,
      compiledAt: new Date().toISOString() });
  }
  const hasManagementPlans = readdirSync(files.plans).some((name) => name.toLowerCase().endsWith(".json"));
  return { routingRequired, hasManagementPlans };
}

// 제목 변경·삭제 배치를 적용한다(25건 단위, 영수증으로 이어받기).
async function applyManagementPlans({ files, api, accountId, job }) {
  const prepare = preparePlanSet(files.plans);
  if (!(prepare.summary?.remainingActions > 0)) return;
  const planTotal = prepare.summary.remainingActions;
  jobEvent(job, "apply", `${planTotal}개 제목 변경 또는 삭제를 적용합니다.`);
  reportProgress(job, { phase: "apply-plan", index: 0, total: planTotal });
  await untilDone(job, "제목 변경·삭제", async () => {
    const remaining = preparePlanSet(files.plans).summary;
    if (remaining.remainingActions === 0) return;
    const applied = await applyPlanSet({ plansDir: files.plans, confirmation: remaining.expectedConfirmation, accountId, api,
      onProgress: (event) => {
        if (event.type === "batch-finish") {
          reportProgress(job, { phase: "apply-plan", total: planTotal,
            index: planTotal - preparePlanSet(files.plans).summary.remainingActions });
        }
        jobEvent(job, "apply", event.type === "batch-start"
          ? `배치 ${event.batch}: ${event.actions}건 시작`
          : `배치 완료: ${event.actions}건${event.ok ? "" : " (실패)"}`);
      } });
    assert(applied.ok, applied.error || "제목 변경 또는 삭제 적용에 실패했습니다");
  });
}

// 프로젝트 배치·이동(25건 단위 타깃)을 적용하고 결과를 기준선에 반영한다.
async function routingStage({ files, api, accountId, job }) {
  const routing = validateProjectRouting(readJson(files.routing, "프로젝트 배치 계획"));
  const routingPrepare = prepareProjectRouting(routing);
  const routingStatus = projectRoutingStatus(routing);
  if (routingStatus.pendingTargets > 0) {
    jobEvent(job, "routing", `${routingPrepare.conversationCount}개 대화를 승인된 프로젝트에 배치합니다.`);
    reportProgress(job, { phase: "routing", index: routingStatus.completedConversations, total: routingStatus.totalConversations });
    await untilDone(job, "프로젝트 배치", async () => {
      if (projectRoutingStatus(routing).pendingTargets === 0) return;
      const routed = await runProjectRouting({ routing, confirmation: routingPrepare.expectedConfirmation,
        accountId, api, pendingOnly: true,
        onProgress: (event) => {
          if (event.type === "target-finish") {
            const status = projectRoutingStatus(routing);
            reportProgress(job, { phase: "routing", index: status.completedConversations, total: status.totalConversations });
          }
          jobEvent(job, "routing", event.type === "target-start"
            ? `배치 ${event.index}/${event.targets}: ${event.projectName} (${event.conversations}건)`
            : `배치 완료: ${event.projectName}`);
        } });
      const failed = routed.results?.find((item) => !item.ok);
      assert(routed.ok, `프로젝트 배치에 실패했습니다: ${failed?.error || ""}`);
    });
  } else {
    jobEvent(job, "routing", "기존 영수증으로 프로젝트 배치 완료를 확인했습니다.");
  }
}

// 검토 대기 목록·결과 보고서·포인터를 마무리한다. 보고서 실패는 적용 자체를 실패로 만들지 않는다.
function finishRun({ workspace, dataDir, pointer, job, afterCatalog, renameOrder, deletes, decisionCount }) {
  try { settleTrash(pointer, dataDir, afterCatalog); }
  catch (error) { jobEvent(job, "report", `삭제후보 목록을 갱신하지 못했습니다: ${error.message}`); }
  let report = null;
  try { report = writeResultReport(pointer, afterCatalog, renameOrder); }
  catch (error) { jobEvent(job, "report", `결과 보고서를 만들지 못했습니다: ${error.message}`); }
  if (report) jobEvent(job, "report", `결과: ${report.headline}`);
  const result = { counts: afterCatalog.counts, deletes, proposalCount: decisionCount, headline: report?.headline || null };
  writePointer(workspace, { ...pointer, phase: PHASE.COMPLETE, result });
  jobEvent(job, "complete", "원격 적용을 완료했습니다. 대화별 재조회로 검증한 결과가 영수증에 남았습니다.");
  job.result = { phase: PHASE.COMPLETE, ...result };
}

export async function applyWorkflow(workspace, dataDir, api, accountId, confirmDeletes, job) {
  const pointer = readPointer(workspace, dataDir);
  const files = runFiles(pointer?.runDir || "");
  const { deletes, decisionCount } = checkApplyPreconditions({ workspace, dataDir, pointer, files, confirmDeletes });
  let lockHeld = false;
  try {
    jobEvent(job, "lock", "로컬 유지관리 잠금을 획득합니다.");
    acquireLock({ dataDir });
    lockHeld = true;
    const { routingRequired, hasManagementPlans } = compilePlans({ pointer, files, job });
    if (hasManagementPlans) await applyManagementPlans({ files, api, accountId, job });
    if (routingRequired) await routingStage({ files, api, accountId, job });
    jobEvent(job, "verify", "승인된 결정과 완료된 계획·영수증이 서로 맞는지 확인합니다.");
    const { afterCatalog, renameOrder } = finalizeMaintenanceRun({ inventoryPath: pointer.inventoryPath, decisionsPath: files.decisions,
      plansDir: hasManagementPlans ? files.plans : "", routingPath: routingRequired ? files.routing : "" });
    finishRun({ workspace, dataDir, pointer, job, afterCatalog, renameOrder, deletes, decisionCount });
  } finally {
    if (lockHeld) releaseLock({ dataDir });
  }
}

// 삭제후보 프로젝트 다시 확인(읽기 전용): 그 프로젝트의 지금 대화를 읽어, 사용자가 ChatGPT에서 직접 지우거나 옮긴 대화를 목록에서 뺀다.
export async function trashSyncWorkflow(workspace, dataDir, api, job) {
  const trash = readTrash(dataDir);
  assert(trash.items.length && trash.project, "확인할 삭제후보 대화가 없습니다");
  let lockHeld = false;
  try {
    jobEvent(job, "lock", "로컬 유지관리 잠금을 획득합니다.");
    acquireLock({ dataDir });
    lockHeld = true;
    jobEvent(job, "scan", `삭제후보 프로젝트 「${trash.project}」의 지금 대화를 읽습니다(읽기 전용).`);
    let present = new Set();
    try {
      const catalog = await untilDone(job, "삭제후보 확인", () => collectScopedCatalog(api, { kind: "project", projectName: trash.project },
        () => new Date(), (info) => reportProgress(job, info)));
      present = new Set(catalog.conversations.map((item) => item.conversationId));
    } catch (error) {
      // 프로젝트 자체가 지워졌다면 그 안의 대화도 더 이상 그곳에 없다.
      if (!/프로젝트를 찾을 수 없습니다/.test(String(error?.message || ""))) throw error;
    }
    const gone = trash.items.filter((item) => !present.has(item.conversationId)).map((item) => item.conversationId);
    if (gone.length) removeTrashed(dataDir, gone);
    const summary = { released: gone.length, remaining: trash.items.length - gone.length };
    jobEvent(job, "complete", `삭제후보 ${trash.items.length}건 중 ${gone.length}건은 이미 지웠거나 옮기셔서 목록에서 뺐습니다. 남은 것 ${summary.remaining}건.`);
    job.result = { trashSync: summary };
  } finally {
    if (lockHeld) releaseLock({ dataDir });
  }
}

// 프로젝트 이름 목록 읽기(읽기 전용, 요청 1~2회): 범위 선택의 프로젝트 목록을 채운다.
export async function projectListWorkflow(dataDir, api, job) {
  jobEvent(job, "scan", "ChatGPT 프로젝트 이름 목록을 읽습니다(읽기 전용).");
  const names = await untilDone(job, "프로젝트 목록", () => listProjectNames(api));
  writeKnownProjects(dataDir, names);
  jobEvent(job, "complete", `프로젝트 ${names.length}개를 읽었습니다.`);
  job.result = { projects: names.length };
}
