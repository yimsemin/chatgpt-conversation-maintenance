// /maintenance/* 요청을 처리하는 라우터. 실제 일은 web-*.js 모듈이 한다.
import { assert } from "./assert.js";
import { relayBroker } from "./remote-relay.js";
import { readTrash } from "./trash.js";
import { APP_ROOT, createSafeDiagnostic, jsonResponse, readRequestJson, validateMaintenanceWorkspace } from "./web-common.js";
import { createJob, jobLogFor, jobs, publicJob, relayAccountId, relayApi, startAsyncJob } from "./web-jobs.js";
import { catalogData, proposalData, reportData, reviewedDecisionsData, sessionData, summaryData, workspaceStatus } from "./web-views.js";
import { prepareTrashFollowUp, savePastedProposal, writeReviewedDecisions } from "./web-decisions.js";
import { applyWorkflow, trashSyncWorkflow, projectListWorkflow, scanWorkflow } from "./web-workflows.js";
import { validateScope } from "./scan.js";

export { jobEvent, formatScanProgress, reportProgress } from "./web-jobs.js";
export { createSafeDiagnostic, validateMaintenanceWorkspace } from "./web-common.js";
export { buildReviewedDecisionsFromInputs, buildReviewedDecisions } from "./web-decisions.js";
export { planReuseDecision, assertApplyablePhase } from "./web-workflows.js";

const RELAY_REQUIRED = "ChatGPT 릴레이가 연결되지 않았습니다 — chatgpt.com에서 북마클릿을 실행하세요";

// ---- 라우트 정의 ----
// 각 라우트는 (ctx) => 값 을 돌려준다. ctx 에는 검증된 작업 폴더(workspace, dataDir)와 요청 본문·쿼리가 있다.
// 작업을 시작하는 라우트는 startJob() 결과(202)를 돌려준다.

const ROUTES = new Map();
function route(method, path, options, handler) {
  if (typeof options === "function") { handler = options; options = {}; }
  ROUTES.set(`${method} ${path}`, { options, handler });
}
const get = (path, options, handler) => route("GET", path, options, handler);
const post = (path, options, handler) => route("POST", path, options, handler);

// 릴레이 연결을 확인하고 작업을 만들어 백그라운드로 시작한다. 응답은 작업 ID 하나다.
function startJob(ctx, { kind = "scan", stage = kind, requestDelayMs, run }) {
  assert(relayBroker.status().connected, RELAY_REQUIRED);
  const job = createJob(kind, ctx.workspace, ctx.dataDir);
  const api = relayApi(job, requestDelayMs);
  startAsyncJob(job, stage, () => run(api, job));
  return { status: 202, value: { jobId: job.id } };
}

get("/maintenance/status", { workspace: "raw" }, (ctx) => workspaceStatus(ctx.workspaceValue));
get("/maintenance/session", (ctx) => sessionData(ctx.workspace, ctx.dataDir));
get("/maintenance/proposal", (ctx) => proposalData(ctx.workspace, ctx.dataDir));
get("/maintenance/summary", (ctx) => summaryData(ctx.workspace, ctx.dataDir));
get("/maintenance/report", (ctx) => reportData(ctx.workspace, ctx.dataDir));
get("/maintenance/catalog", (ctx) => catalogData(ctx.workspace, ctx.dataDir));
get("/maintenance/decisions", (ctx) => reviewedDecisionsData(ctx.workspace, ctx.dataDir));

get("/maintenance/trash", (ctx) => {
  const trash = readTrash(ctx.dataDir);
  return {
    project: trash.project,
    items: trash.items.map((item) => ({
      conversationId: item.conversationId, title: item.title, fromProject: item.fromProject, reason: item.reason,
      intendedTarget: item.intendedTarget, trashedAt: item.trashedAt,
    })),
  };
});
post("/maintenance/trash/prepare", (ctx) => prepareTrashFollowUp(ctx.workspace, ctx.dataDir, ctx.body.decisions));
post("/maintenance/proposal", (ctx) => savePastedProposal(ctx.workspace, ctx.dataDir, ctx.body.proposalJson));
post("/maintenance/decisions", (ctx) =>
  writeReviewedDecisions(ctx.workspace, ctx.dataDir, ctx.body.decisions, ctx.body.trash || null));

get("/maintenance/jobs", (ctx) => {
  const active = [...jobs.values()].filter((job) => job.workspace === ctx.workspace && !job.done).map(publicJob);
  const recent = jobLogFor(ctx.dataDir).recent(10).filter((item) => !active.some((job) => job.id === item.id));
  return { active, recent };
});
// 최근 작업 기록 지우기: 이 컴퓨터의 작업 로그(data/jobs)만 지운다. 정리 결과(runs/)와 ChatGPT는 그대로다.
post("/maintenance/jobs/clear", (ctx) => {
  const active = [...jobs.values()].filter((job) => job.workspace === ctx.workspace && !job.done);
  const removed = jobLogFor(ctx.dataDir).clear(active.map((job) => job.logFile).filter(Boolean));
  for (const [id, job] of jobs) if (job.workspace === ctx.workspace && job.done) jobs.delete(id);
  return { removed };
});
post("/maintenance/cancel", { workspace: "none" }, (ctx) => {
  const job = jobs.get(ctx.body.jobId);
  if (!job || job.done) return { status: 404, value: { error: { code: "JOB_NOT_FOUND", message: "진행 중인 작업이 없습니다" } } };
  job.cancelled = true;
  return { cancelling: true };
});

post("/maintenance/scan", (ctx) => {
  const scope = validateScope(ctx.body.scope);
  return startJob(ctx, { run: (api, job) => scanWorkflow(ctx.workspace, ctx.dataDir, api, job, { scope }) });
});
post("/maintenance/projects", (ctx) => startJob(ctx, {
  run: (api, job) => projectListWorkflow(ctx.dataDir, api, job),
}));
post("/maintenance/trash/sync", (ctx) => startJob(ctx, {
  run: (api, job) => trashSyncWorkflow(ctx.workspace, ctx.dataDir, api, job),
}));
post("/maintenance/apply", (ctx) => startJob(ctx, {
  kind: "apply", requestDelayMs: 2000,
  run: async (api, job) => applyWorkflow(ctx.workspace, ctx.dataDir, api, await relayAccountId(api),
    ctx.body.confirmDeletes === true, job),
}));

function jobStatus(jobId) {
  const job = jobs.get(jobId);
  return job ? { value: publicJob(job) }
    : { status: 404, value: { error: { code: "JOB_NOT_FOUND", message: "작업 상태를 찾을 수 없습니다" } } };
}

export async function handleMaintenanceWebRequest(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (!url.pathname.startsWith("/maintenance/")) return false;
  try {
    if (req.method === "GET" && url.pathname.startsWith("/maintenance/job/")) {
      const { status = 200, value } = jobStatus(url.pathname.slice("/maintenance/job/".length));
      jsonResponse(res, status, value);
      return true;
    }
    const entry = ROUTES.get(`${req.method} ${url.pathname}`);
    if (!entry) {
      jsonResponse(res, 404, { error: { code: "NOT_FOUND", message: "지원하지 않는 유지관리 요청입니다" } });
      return true;
    }
    const body = req.method === "POST" ? await readRequestJson(req) : {};
    // 작업 폴더는 항상 요청이 밝혀야 한다. 기본값을 두면 모의 서버 같은 임시 환경에서도 요청이 실제 데이터 폴더로 향할 수 있다.
    const workspaceValue = req.method === "POST" ? body.workspace : url.searchParams.get("workspace");
    const ctx = { url, body, workspaceValue };
    if (entry.options.workspace !== "raw" && entry.options.workspace !== "none") {
      Object.assign(ctx, validateMaintenanceWorkspace(workspaceValue));
    }
    const result = entry.handler(ctx);
    const { status = 200, value } = result && typeof result === "object" && "value" in result && "status" in result
      ? result : { value: result };
    jsonResponse(res, status, value);
    return true;
  } catch (error) {
    jsonResponse(res, 400, { error: createSafeDiagnostic("request", error, url.searchParams.get("workspace") || APP_ROOT) });
    return true;
  }
}
