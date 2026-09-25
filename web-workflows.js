// 원격에 닿는 워크플로: 스캔, 검증(probe), 적용. 잠금·영수증·체크포인트를 다룬다.
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert } from "./assert.js";
import { sha256 } from "./content-hash.js";
import { runsDir, stateFilePath } from "./data-dir.js";
import { acquireLock, releaseLock } from "./maintenance-lock.js";
import { applyPlanSet, preparePlanSet } from "./management-cli.js";
import { checkpointMaintenanceRun, scanMaintenanceRun, synchronizeMaintenanceStateAfterProjectRouting } from "./maintenance-cli.js";
import { prepareProjectRouting, projectRoutingStatus, runProjectRouting, validateProjectRouting } from "./project-routing.js";
import { compileProjectRouting, compileReviewedDecisions, writeClassificationReview } from "./workflow.js";
import { addParked, removeParked } from "./parking.js";
import { probeFastCatalog } from "./catalog.js";
import { buildResultReport, reportMarkdown, rowsFromDecisions } from "./summary.js";
import { publicPointer, readJson, readPointer, runId, writeJsonAtomic, writePointer } from "./web-common.js";
import { jobEvent, reportProgress, untilDone } from "./web-jobs.js";
import { PROBE_FILE, proposalData, readProbe, shouldScanIncrementally } from "./web-views.js";
import { buildReviewedDecisions } from "./web-decisions.js";

// 전수 수집은 도중에 끊겨도 이어받도록 인벤토리가 없는 overhaul- 실행 폴더를 재사용한다.
export function overhaulRunDir(dataDir) {
  const root = runsDir(dataDir);
  const open = existsSync(root)
    ? readdirSync(root).filter((name) => name.startsWith("overhaul-")
      && !existsSync(join(root, name, "inventory.json"))).sort().pop()
    : null;
  return join(root, open || `overhaul-${runId()}`);
}

export async function scanWorkflow(workspace, dataDir, api, job, { full = false, forceFull = false } = {}) {
  let lockHeld = false;
  try {
    jobEvent(job, "lock", "로컬 유지관리 잠금을 획득합니다.");
    acquireLock({ dataDir });
    lockHeld = true;
    const id = runId();
    const runDir = full ? overhaulRunDir(dataDir) : join(runsDir(dataDir), id);
    const inventoryPath = join(runDir, "inventory.json");
    const reviewPath = join(runDir, "review.json");
    let baselineGeneratedAt = null;
    try { baselineGeneratedAt = readJson(stateFilePath(dataDir), "기준선").generatedAt; } catch {}
    const incremental = !full && shouldScanIncrementally({ probe: readProbe(dataDir), baselineGeneratedAt, forceFull });
    jobEvent(job, "scan", full
      ? "전수 재정비: 모든 대화 본문을 받습니다. 이미 받은 것은 건너뜁니다."
      : incremental
        ? "증분 스캔: 최근 수정된 대화만 확인합니다(삭제된 대화는 전체 스캔에서 확인)."
        : "전체 스캔: ChatGPT의 모든 대화 목록을 확인합니다.");
    const scanResult = await scanMaintenanceRun({
      statePath: stateFilePath(dataDir),
      runDir,
      api,
      dataDir,
      full,
      incremental,
      onProgress: (info) => reportProgress(job, info),
    });
    const scan = { counts: scanResult.inventory.counts, warnings: scanResult.inventory.warnings };
    const candidateCount = Number(scan.counts?.candidates || 0);
    const heldCount = Number(scan.counts?.held || 0);
    if (heldCount > 0) {
      jobEvent(job, "hold", `${heldCount}개는 형식만 어긋난 보류 항목이라 이번 재분류에서 제외했습니다.`);
    }
    const pointer = {
      phase: candidateCount > 0 ? "awaiting-proposal" : "complete",
      runDir,
      inventoryPath,
      reviewPath: candidateCount > 0 ? reviewPath : null,
      proposalPath: join(runDir, "proposal.json"),
      result: { counts: scan.counts, warnings: scan.warnings || [] },
    };
    if (candidateCount > 0) {
      jobEvent(job, "review", "AI가 읽을 최소 분류 입력을 만듭니다.");
      writeClassificationReview(inventoryPath, reviewPath);
      writePointer(workspace, pointer);
      job.result = { phase: "awaiting-proposal", run: publicPointer({ ...pointer, updatedAt: new Date().toISOString() }) };
      jobEvent(job, "ready", `${candidateCount}개 후보의 분류 요청 준비가 끝났습니다.`);
      return;
    }
    writePointer(workspace, pointer);
    jobEvent(job, "complete", "분류할 후보가 없어 기준선을 갱신했습니다.");
    job.result = { phase: "complete", run: publicPointer({ ...pointer, updatedAt: new Date().toISOString() }) };
  } finally {
    if (lockHeld) releaseLock({ dataDir });
  }
}

export async function probeWorkflow(workspace, dataDir, api, job) {
  jobEvent(job, "probe", "빠른 목록 방식이 전체 방식과 같은 결과인지 읽기 전용으로 확인합니다(수 분 걸릴 수 있음).");
  const result = await probeFastCatalog(api, { onProgress: (info) => reportProgress(job, info) });
  writeJsonAtomic(join(dataDir, PROBE_FILE), result);
  jobEvent(job, "probe", result.ok
    ? `확인 완료: 대화 ${result.total}건에서 두 방식의 결과가 같습니다. 다음 확인부터 증분 스캔을 씁니다.`
    : result.reason === "unsupported" ? `이 계정의 목록 응답으로는 빠른 방식을 쓸 수 없습니다: ${result.message}`
      : `두 방식의 결과가 다릅니다(프로젝트 소속 불일치 ${result.counts?.project ?? 0}건 등). 전체 방식을 계속 씁니다.`);
  job.result = { probe: result };
}

// 적용이 끝난 뒤 검토 대기 목록을 맞춘다: 새로 보관한 대화를 더하고, 후속 실행으로 처리한 대화를 뺀다.
export function settleParking(pointer, dataDir, state) {
  const metaPath = join(pointer.runDir, "parking-meta.json");
  if (existsSync(metaPath)) {
    const meta = readJson(metaPath, "임시 보관 정보");
    addParked(dataDir, { project: meta.project, items: meta.items });
  }
  const followPath = join(pointer.runDir, "followup.json");
  if (existsSync(followPath)) {
    const follow = readJson(followPath, "후속 실행 정보");
    const stillParked = new Set(state.conversations.filter((item) => item.projectName === follow.project).map((item) => item.conversationId));
    removeParked(dataDir, follow.ids.filter((id) => !stillParked.has(id)));
  }
}

export function writeResultReport(pointer, statePath, quiet) {
  const inventory = readJson(pointer.inventoryPath, "인벤토리");
  const catalogBefore = readJson(inventory.catalogFile, "카탈로그");
  const decisions = readJson(join(pointer.runDir, "reviewed-decisions.json"), "검토된 결정");
  const report = buildResultReport({
    catalogBefore,
    catalogAfter: readJson(statePath, "최종 기준선"),
    rows: rowsFromDecisions(decisions, inventory),
    verification: quiet ? "assume-quiet" : "full",
  });
  writeJsonAtomic(join(pointer.runDir, "report.json"), report);
  writeFileSync(join(pointer.runDir, "report.md"), reportMarkdown(report), { mode: 0o600 });
  return report;
}

export const PLAN_SOURCE_FILE = "compiled-plan-source.json";

export const PLAN_HALT_MESSAGES = {
  "changed-after-apply": "이미 적용한 결과(영수증)가 있는데 결정이 바뀌었습니다. "
    + "이 실행의 계획은 안전하게 다시 만들 수 없으므로 여기서 멈춥니다. "
    + "‘새 대화 확인’으로 현재 ChatGPT 상태를 다시 스캔한 뒤 새 실행에서 결정하세요.",
  "unknown-source-after-apply": "이 실행의 계획이 어떤 결정에서 나왔는지 확인할 수 없고 적용 결과(영수증)도 있습니다. "
    + "안전을 위해 멈춥니다. ‘새 대화 확인’으로 다시 스캔한 뒤 새 실행에서 결정하세요.",
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
  assert(phase !== "complete",
    "이 실행은 이미 적용을 마쳤습니다. 새 변경은 ‘새 대화 확인’으로 다시 스캔한 뒤 결정하세요.");
  return true;
}

export function receiptFileCount(receiptDir) {
  if (!existsSync(receiptDir)) return 0;
  return readdirSync(receiptDir).filter((name) => name.toLowerCase().endsWith(".json")).length;
}

export async function applyWorkflow(workspace, dataDir, api, accountId, confirmDeletes, job, { quiet = false } = {}) {
  const pointer = readPointer(workspace, dataDir);
  assert(pointer, "적용할 현재 실행이 없습니다");
  assertApplyablePhase(pointer.phase);
  const decisionsPath = join(pointer.runDir, "reviewed-decisions.json");

  // 화면에서 저장한 결정이 있으면 그것을 그대로 쓰고, 없으면 붙여넣은 proposal.json에서 만든다.
  let deletes;
  let proposalCount;
  if (existsSync(decisionsPath)) {
    const reviewed = readJson(decisionsPath, "검토된 결정");
    assert(reviewed?.version === 1 && reviewed.kind === "reviewed-decisions"
      && Array.isArray(reviewed.decisions), "reviewed-decisions.json 형식이 올바르지 않습니다");
    deletes = reviewed.decisions.filter((item) => item.decision === "delete").length;
    proposalCount = reviewed.decisions.length;
  } else {
    const proposal = proposalData(workspace, dataDir);
    assert(proposal.ready, "화면에서 결정을 저장하거나 proposal.json을 붙여넣으세요");
    assert(proposal.blockers.undecided === 0, "undecided 항목은 승인 전에 해결해야 합니다");
    deletes = proposal.items.filter((item) => item.suggestedDecision === "delete").length;
    proposalCount = proposal.items.length;
  }
  assert(deletes === 0 || confirmDeletes === true, `${deletes}개 삭제 후보에 대한 별도 확인이 필요합니다`);

  const statePath = stateFilePath(dataDir);
  const plansDir = join(pointer.runDir, "plans");
  const routingPath = join(pointer.runDir, "routing.json");
  let lockHeld = false;
  try {
    jobEvent(job, "lock", "로컬 유지관리 잠금을 획득합니다.");
    acquireLock({ dataDir });
    lockHeld = true;

    if (!existsSync(decisionsPath)) {
      writeJsonAtomic(decisionsPath, buildReviewedDecisions(pointer, readJson(pointer.proposalPath, "분류안")));
    }

    // 적용에 실패한 뒤 사용자가 결정을 바꿨을 수 있다. 최신 승인과 이미 컴파일된 계획이
    // 같은 결정에서 나왔는지 먼저 확인한다. 어긋나면 아직 적용 결과가 없을 때만 다시 만들고,
    // 영수증이 있으면 옛 계획을 실행하지도 지우지도 않고 여기서 멈춘다.
    const decisionsDigest = sha256(readFileSync(decisionsPath));
    const planSourcePath = join(pointer.runDir, PLAN_SOURCE_FILE);
    // 출처 파일이 깨졌으면 출처를 모르는 계획으로 취급한다(아래에서 영수증이 있으면 중단한다).
    let planSource = null;
    if (existsSync(planSourcePath)) {
      try { planSource = readJson(planSourcePath, "계획 출처"); } catch { planSource = null; }
    }
    const reuse = planReuseDecision({
      hasCompiledArtifacts: existsSync(plansDir) || existsSync(routingPath),
      stampDigest: planSource?.decisionsDigest || null,
      decisionsDigest,
      hasReceipts: receiptFileCount(join(pointer.runDir, "receipts")) > 0,
    });
    assert(reuse.action !== "halt", PLAN_HALT_MESSAGES[reuse.reason]);
    if (reuse.action === "recompile") {
      jobEvent(job, "compile", "결정이 바뀌어 아직 적용되지 않은 이전 계획을 버리고 다시 만듭니다.");
      rmSync(plansDir, { recursive: true, force: true });
      rmSync(routingPath, { force: true });
    }

    jobEvent(job, "compile", "승인된 제목·삭제·프로젝트 계획을 컴파일합니다.");
    if (!existsSync(plansDir)) {
      compileReviewedDecisions(pointer.inventoryPath, decisionsPath, plansDir);
    }
    let routingCompile = null;
    if (!existsSync(routingPath)) {
      routingCompile = compileProjectRouting(pointer.inventoryPath, decisionsPath, routingPath);
    } else {
      routingCompile = { routingRequired: true, routingPath };
    }
    if (reuse.action !== "reuse") {
      writeJsonAtomic(planSourcePath, {
        version: 1,
        kind: "compiled-plan-source",
        decisionsDigest,
        compiledAt: new Date().toISOString(),
      });
    }

    const hasManagementPlans = readdirSync(plansDir).some((name) => name.toLowerCase().endsWith(".json"));
    if (hasManagementPlans) {
      const prepare = preparePlanSet(plansDir);
      if (prepare.summary?.remainingActions > 0) {
        jobEvent(job, "apply", `${prepare.summary.remainingActions}개 제목 변경 또는 삭제를 적용합니다.`);
        const planTotal = prepare.summary.remainingActions;
        reportProgress(job, { phase: "apply-plan", index: 0, total: planTotal });
        await untilDone(job, "제목 변경·삭제", async () => {
          const remaining = preparePlanSet(plansDir).summary;
          if (remaining.remainingActions === 0) return;
          const applied = await applyPlanSet({ plansDir, confirmation: remaining.expectedConfirmation, accountId, api,
            onProgress: (event) => {
              if (event.type === "batch-finish") {
                reportProgress(job, { phase: "apply-plan", total: planTotal,
                  index: planTotal - preparePlanSet(plansDir).summary.remainingActions });
              }
              jobEvent(job, "apply", event.type === "batch-start"
                ? `배치 ${event.batch}: ${event.actions}건 시작`
                : `배치 완료: ${event.actions}건${event.ok ? "" : " (실패)"}`);
            } });
          assert(applied.ok, applied.error || "제목 변경 또는 삭제 적용에 실패했습니다");
        });
      }
    }

    jobEvent(job, "checkpoint", quiet
      ? "적용 결과를 빠른 검증으로 확인합니다(전체 카탈로그 재수집 생략, 최근 수정 목록만 대조)."
      : "적용 결과와 원격 상태를 전체 카탈로그 재수집으로 검증합니다(수 분 걸릴 수 있음).");
    const onProgress = (info) => reportProgress(job, info);
    await untilDone(job, "체크포인트", () => checkpointMaintenanceRun({ inventoryPath: pointer.inventoryPath,
      decisionsPath, statePath, plansDir: hasManagementPlans ? plansDir : "", api, quiet, onProgress }));
    jobEvent(job, "checkpoint", "체크포인트 검증을 통과했고 기준선을 갱신했습니다.");

    if (routingCompile.routingRequired) {
      const routing = validateProjectRouting(readJson(routingPath, "프로젝트 배치 계획"));
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
      jobEvent(job, "verify", quiet
        ? "프로젝트 배치를 영수증 기준으로 반영하고 최근 수정 목록만 대조합니다."
        : "프로젝트 배치와 최종 기준선을 전체 카탈로그 재수집으로 검증합니다.");
      await untilDone(job, "배치 검증", () => synchronizeMaintenanceStateAfterProjectRouting({
        statePath, routingPath, api, quiet, onProgress }));
      jobEvent(job, "verify", "프로젝트 배치 검증을 통과했고 기준선을 갱신했습니다.");
    }

    const state = readJson(statePath, "최종 기준선");
    try { settleParking(pointer, dataDir, state); }
    catch (error) { jobEvent(job, "report", `검토 대기 목록을 갱신하지 못했습니다: ${error.message}`); }
    let report = null;
    try { report = writeResultReport(pointer, statePath, quiet); }
    catch (error) { jobEvent(job, "report", `결과 보고서를 만들지 못했습니다: ${error.message}`); }
    if (report) jobEvent(job, "report", `결과: ${report.headline}`);
    const result = {
      counts: state.counts,
      deletes,
      proposalCount,
      headline: report?.headline || null,
    };
    writePointer(workspace, { ...pointer, phase: "complete", result });
    jobEvent(job, "complete", "원격 적용과 기준선 갱신을 완료했습니다.");
    job.result = { phase: "complete", ...result };
  } finally {
    if (lockHeld) releaseLock({ dataDir });
  }
}
