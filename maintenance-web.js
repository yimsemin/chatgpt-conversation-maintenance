// /maintenance/* 요청을 처리하는 라우터. 실제 일은 web-*.js 모듈이 한다.
import { assert } from "./assert.js";
import { relayBroker } from "./remote-relay.js";
import { readParking } from "./parking.js";
import { APP_ROOT, createSafeDiagnostic, jsonResponse, readRequestJson, validateMaintenanceWorkspace } from "./web-common.js";
import { createJob, jobLogFor, jobs, publicJob, relayAccountId, relayApi, startAsyncJob } from "./web-jobs.js";
import { catalogData, proposalData, reportData, reviewedDecisionsData, sessionData, summaryData, workspaceStatus } from "./web-views.js";
import { prepareParkingFollowUp, savePastedProposal, writeReviewedDecisions } from "./web-decisions.js";
import { applyWorkflow, probeWorkflow, scanWorkflow } from "./web-workflows.js";

export { jobEvent, formatScanProgress, reportProgress } from "./web-jobs.js";
export { createSafeDiagnostic, validateMaintenanceWorkspace } from "./web-common.js";
export { buildReviewedDecisionsFromInputs, buildReviewedDecisions } from "./web-decisions.js";
export { planReuseDecision, assertApplyablePhase } from "./web-workflows.js";
export { shouldScanIncrementally } from "./web-views.js";

export async function handleMaintenanceWebRequest(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (!url.pathname.startsWith("/maintenance/")) return false;
  try {
    if (req.method === "GET" && url.pathname === "/maintenance/status") {
      jsonResponse(res, 200, workspaceStatus(url.searchParams.get("workspace") || APP_ROOT));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/maintenance/proposal") {
      const { workspace, dataDir } = validateMaintenanceWorkspace(url.searchParams.get("workspace") || APP_ROOT);
      jsonResponse(res, 200, proposalData(workspace, dataDir));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/maintenance/session") {
      const { workspace, dataDir } = validateMaintenanceWorkspace(url.searchParams.get("workspace") || APP_ROOT);
      jsonResponse(res, 200, sessionData(workspace, dataDir));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/maintenance/parking") {
      const { dataDir, state } = validateMaintenanceWorkspace(url.searchParams.get("workspace") || APP_ROOT);
      const parking = readParking(dataDir);
      const present = new Map(state.conversations.map((item) => [item.conversationId, item]));
      jsonResponse(res, 200, { project: parking.project, items: parking.items.map((item) => ({
        conversationId: item.conversationId, title: present.get(item.conversationId)?.title || item.title,
        fromProject: item.fromProject, reason: item.reason, intendedTarget: item.intendedTarget, parkedAt: item.parkedAt,
        inBaseline: present.has(item.conversationId),
      })) });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/maintenance/parking/prepare") {
      const body = await readRequestJson(req);
      const { workspace, dataDir } = validateMaintenanceWorkspace(body.workspace || APP_ROOT);
      jsonResponse(res, 200, prepareParkingFollowUp(workspace, dataDir, body.decisions));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/maintenance/summary") {
      const { workspace, dataDir } = validateMaintenanceWorkspace(url.searchParams.get("workspace") || APP_ROOT);
      jsonResponse(res, 200, summaryData(workspace, dataDir));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/maintenance/report") {
      const { workspace, dataDir } = validateMaintenanceWorkspace(url.searchParams.get("workspace") || APP_ROOT);
      jsonResponse(res, 200, reportData(workspace, dataDir));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/maintenance/catalog") {
      const { workspace, dataDir } = validateMaintenanceWorkspace(url.searchParams.get("workspace") || APP_ROOT);
      jsonResponse(res, 200, catalogData(workspace, dataDir));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/maintenance/decisions") {
      const { workspace, dataDir } = validateMaintenanceWorkspace(url.searchParams.get("workspace") || APP_ROOT);
      jsonResponse(res, 200, reviewedDecisionsData(workspace, dataDir));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/maintenance/proposal") {
      const body = await readRequestJson(req);
      const { workspace, dataDir } = validateMaintenanceWorkspace(body.workspace || APP_ROOT);
      jsonResponse(res, 200, savePastedProposal(workspace, dataDir, body.proposalJson));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/maintenance/decisions") {
      const body = await readRequestJson(req);
      const { workspace, dataDir } = validateMaintenanceWorkspace(body.workspace || APP_ROOT);
      jsonResponse(res, 200, writeReviewedDecisions(workspace, dataDir, body.decisions, body.parking || null));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/maintenance/jobs") {
      const { workspace, dataDir } = validateMaintenanceWorkspace(url.searchParams.get("workspace") || APP_ROOT);
      const active = [...jobs.values()].filter((job) => job.workspace === workspace && !job.done).map(publicJob);
      const recent = jobLogFor(dataDir).recent(10).filter((item) => !active.some((job) => job.id === item.id));
      jsonResponse(res, 200, { active, recent });
      return true;
    }
    if (req.method === "GET" && url.pathname.startsWith("/maintenance/job/")) {
      const id = url.pathname.slice("/maintenance/job/".length);
      const job = jobs.get(id);
      if (!job) jsonResponse(res, 404, { error: { code: "JOB_NOT_FOUND", message: "작업 상태를 찾을 수 없습니다" } });
      else jsonResponse(res, 200, publicJob(job));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/maintenance/scan") {
      const body = await readRequestJson(req);
      const { workspace, dataDir } = validateMaintenanceWorkspace(body.workspace || APP_ROOT);
      assert(relayBroker.status().connected, "ChatGPT 릴레이가 연결되지 않았습니다 — chatgpt.com에서 북마클릿을 실행하세요");
      const job = createJob("scan", workspace, dataDir);
      const api = relayApi(job);
      startAsyncJob(job, "scan", () => scanWorkflow(workspace, dataDir, api, job, { forceFull: body.full === true }));
      jsonResponse(res, 202, { jobId: job.id });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/maintenance/probe") {
      const body = await readRequestJson(req);
      const { workspace, dataDir } = validateMaintenanceWorkspace(body.workspace || APP_ROOT);
      assert(relayBroker.status().connected, "ChatGPT 릴레이가 연결되지 않았습니다 — chatgpt.com에서 북마클릿을 실행하세요");
      const job = createJob("scan", workspace, dataDir);
      const api = relayApi(job);
      startAsyncJob(job, "probe", () => probeWorkflow(workspace, dataDir, api, job));
      jsonResponse(res, 202, { jobId: job.id });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/maintenance/cancel") {
      const body = await readRequestJson(req);
      const job = jobs.get(body.jobId);
      if (!job || job.done) jsonResponse(res, 404, { error: { code: "JOB_NOT_FOUND", message: "진행 중인 작업이 없습니다" } });
      else {
        job.cancelled = true;
        jsonResponse(res, 200, { cancelling: true });
      }
      return true;
    }
    if (req.method === "POST" && url.pathname === "/maintenance/collect") {
      const body = await readRequestJson(req);
      const { workspace, dataDir } = validateMaintenanceWorkspace(body.workspace || APP_ROOT);
      assert(relayBroker.status().connected, "ChatGPT 릴레이가 연결되지 않았습니다 — chatgpt.com에서 북마클릿을 실행하세요");
      const job = createJob("scan", workspace, dataDir);
      const api = relayApi(job);
      startAsyncJob(job, "scan", () => scanWorkflow(workspace, dataDir, api, job, { full: true }));
      jsonResponse(res, 202, { jobId: job.id });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/maintenance/apply") {
      const body = await readRequestJson(req);
      const { workspace, dataDir } = validateMaintenanceWorkspace(body.workspace || APP_ROOT);
      assert(relayBroker.status().connected, "ChatGPT 릴레이가 연결되지 않았습니다 — chatgpt.com에서 북마클릿을 실행하세요");
      const job = createJob("apply", workspace, dataDir);
      const api = relayApi(job, 2000);
      startAsyncJob(job, "apply", async () => applyWorkflow(workspace, dataDir, api,
        await relayAccountId(api), body.confirmDeletes === true, job, { quiet: body.quiet === true }));
      jsonResponse(res, 202, { jobId: job.id });
      return true;
    }
    jsonResponse(res, 404, { error: { code: "NOT_FOUND", message: "지원하지 않는 유지관리 요청입니다" } });
    return true;
  } catch (error) {
    const workspace = url.searchParams.get("workspace") || APP_ROOT;
    jsonResponse(res, 400, { error: createSafeDiagnostic("request", error, workspace) });
    return true;
  }
}
