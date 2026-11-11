// 작업(스캔·적용) 실행 기반: 작업 목록·이벤트·진행률, 자동 재개, 릴레이 API 생성.
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { assert } from "./assert.js";
import { CONFIG } from "./config.js";
import { ACCOUNT_ID } from "./ids.js";
import { createRelayApi } from "./relay-api.js";
import { relayBroker } from "./remote-relay.js";
import { computeEta, createJobLog, trackProgress, formatDuration } from "./jobs.js";
import { createPacer } from "./relay-api.js";
import { createSafeDiagnostic } from "./web-common.js";

const JOB_TTL_MS = 60 * 60 * 1000;

export const jobs = new Map();

function cleanupJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) if (job.done && job.createdAt < cutoff) jobs.delete(id);
}

const jobLogs = new Map();

export function jobLogFor(dataDir) {
  if (!jobLogs.has(dataDir)) {
    const log = createJobLog(join(dataDir, "jobs"));
    log.closeInterrupted(new Set([...jobs.keys()]));
    jobLogs.set(dataDir, log);
  }
  return jobLogs.get(dataDir);
}

export function createJob(kind, workspace, dataDir = null) {
  cleanupJobs();
  assert(![...jobs.values()].some((job) => !job.done && job.workspace === workspace),
    "이 작업 폴더에서 이미 다른 작업이 진행 중입니다");
  const id = randomUUID();
  const job = { id, kind, workspace, createdAt: Date.now(), events: [], done: false, ok: null, result: null, error: null,
    progress: null };
  jobs.set(id, job);
  if (dataDir) {
    job.log = jobLogFor(dataDir);
    job.log.open(job);
  }
  return job;
}

const TRANSIENT_STAGES = new Set(["rate-limit", "retry"]);

export function jobEvent(job, stage, message) {
  // 대기·재시도 알림은 같은 자리에 덮어쓴다. 나머지 이벤트는 모두 줄을 더한다.
  const last = job.events[job.events.length - 1];
  if (TRANSIENT_STAGES.has(stage) && TRANSIENT_STAGES.has(last?.stage)) {
    last.at = new Date().toISOString();
    last.stage = stage;
    last.message = message;
    persistTransient(job, last);
    return;
  }
  const entry = { at: new Date().toISOString(), stage, message };
  job.events.push(entry);
  job.log?.event(job, entry);
}

// 진행 줄은 자주 바뀌므로 파일에는 5초에 한 번만 남긴다.
function persistTransient(job, entry) {
  const now = Date.now();
  if (now - (job.lastTransientWrite || 0) < 5000) return;
  job.lastTransientWrite = now;
  job.log?.event(job, entry);
}

// 사용자가 읽는 로그 줄: 대상(대화·프로젝트·목록)마다 무슨 일이 있었는지 한 줄로 남긴다. 요청 단위 줄과 다르다.
// COUNTED 종류는 화면의 종류별 누계(job.counts)에 센다.
export const ITEM_VERBS = {
  rename: "제목 변경", move: "프로젝트 이동", trash: "삭제후보로 이동", delete: "삭제", keep: "유지",
  fetch: "본문 받음", reuse: "본문 재활용", skip: "건너뜀",
  project: "프로젝트 읽음", listActive: "활성 대화 목록 읽음", listArchived: "보관 대화 목록 읽음",
};
const COUNTED = new Set(["rename", "move", "trash", "delete", "fetch", "reuse", "skip"]);

export function jobItem(job, kind, { ok = true, title, to = "", detail = "", reason = "" }) {
  job.counts ||= {};
  const key = ok ? kind : "failed";
  if (!ok || COUNTED.has(kind)) job.counts[key] = (job.counts[key] || 0) + 1;
  const verb = ITEM_VERBS[kind];
  const tail = `${to ? ` → ${to}` : ""}${detail ? ` — ${detail}` : ""}`;
  if (kind === "skip") return jobEvent(job, "item-skip", `⚠ ${verb}  ${title}${reason ? ` — ${reason}` : ""}`);
  return jobEvent(job, ok ? "item" : "item-fail", ok ? `✓ ${verb}  ${title}${tail}` : `✗ ${verb} 실패  ${title}${reason ? ` — ${reason}` : ""}`);
}

const SCAN_PROGRESS_LABELS = {
  projects: "프로젝트 목록 읽는 중",
  active: "활성 대화 목록 읽는 중",
  archived: "보관 대화 목록 읽는 중",
  downloads: "후보 대화 본문 받는 중",
  "apply-plan": "제목 변경·삭제 적용 중",
  routing: "프로젝트 이동 중",
};

// 적용은 제목 변경·삭제 뒤에 프로젝트 이동이 이어진다. 단계마다 바가 0으로 돌아가지 않도록 전체 기준 진행도를 함께 낸다.
// job.overall = { planTotal, total } 은 적용 시작 때 정해진다. 남은 시간은 전체 기준으로 다시 계산한다.
function trackOverall(job, progress, info) {
  const overall = job.overall;
  if (!overall || (info.phase !== "apply-plan" && info.phase !== "routing")) return;
  const index = (info.phase === "routing" ? overall.planTotal : 0) + (info.index || 0);
  const now = Date.now();
  overall.startedAtMs ??= now;
  overall.startIndex ??= index;
  const done = index - overall.startIndex;
  progress.overallIndex = Math.min(index, overall.total);
  progress.overallTotal = overall.total;
  // 처음 몇 건은 표본이 적어 시간이 크게 흔들리므로 보여 주지 않는다.
  progress.etaSeconds = done >= 3 ? computeEta({ startedAtMs: overall.startedAtMs, nowMs: now, index: done, total: overall.total - overall.startIndex }) : null;
}

// 진행 정보를 job.progress(단계·건수·남은 시간)와 job.currentItem(지금 처리 중인 대상)에 기록한다.
export function reportProgress(job, info) {
  // 수집 중 "프로젝트·목록 하나를 다 읽었다"는 알림은 진행률이 아니라 로그 줄이다.
  if (info.type === "project-read") return jobItem(job, "project", { title: info.projectName, detail: `대화 ${info.count}건` });
  if (info.type === "list-read") return jobItem(job, info.archived ? "listArchived" : "listActive", { title: `${info.count}건` });
  const progress = trackProgress(job, { phase: info.phase, label: SCAN_PROGRESS_LABELS[info.phase] || info.phase,
    index: info.index, total: info.total });
  trackOverall(job, progress, info);
  // 진행률·남은 시간·지금 처리 중인 대상은 화면의 진행바가 보여 주므로 로그에는 줄을 쌓지 않는다.
  // 로그에는 대상 하나가 끝날 때마다 jobItem 줄이 남는다.
  job.currentItem = info.item || (info.projectName ? `프로젝트 읽는 중  ${info.projectName}` : null);
}

const WAIT_STAGES = new Set(["rate-limit", "relay-down", "retry"]);

export function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    done: job.done,
    ok: job.ok,
    // 서버 요청 줄은 파일 기록에만 남기고 화면에는 대화 단위 줄만 보낸다("상세 기록"에서 요청 줄까지 본다).
    events: job.events.filter((event) => event.stage !== "request").slice(-300),
    currentItem: job.currentItem || null,
    counts: job.counts || null,
    // 마지막 이벤트가 대기·재시도면 사용자 눈에는 멈춘 것처럼 보이므로 진행바가 이유를 알려 준다.
    waiting: !job.done && WAIT_STAGES.has(job.events.at(-1)?.stage) ? { stage: job.events.at(-1).stage, message: job.events.at(-1).message } : null,
    result: job.result,
    error: job.error,
    cancelled: job.cancelled === true,
    createdAt: job.createdAt,
    elapsedSeconds: Math.round(((job.finishedAt || Date.now()) - job.createdAt) / 1000),
    progress: job.progress ? {
      phase: job.progress.phase, label: job.progress.label, index: job.progress.index,
      total: job.progress.total, etaSeconds: job.progress.etaSeconds,
      overallIndex: job.progress.overallIndex ?? null, overallTotal: job.progress.overallTotal ?? null,
    } : null,
  };
}

// 429 쿨다운 대기 중에도 중단 요청에 반응하도록 잘게 나눠 잔다.
async function cancellableSleep(job, ms) {
  for (let left = ms; left > 0; left -= 500) {
    if (job.cancelled) throw new Error("사용자가 중단했습니다");
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, left)));
  }
  if (job.cancelled) throw new Error("사용자가 중단했습니다");
}

// 일시적인 실패(429·릴레이 시간 초과·5xx)는 사용자가 버튼을 다시 누르지 않아도 기다렸다가 이어서 한다.
// 각 단계는 영수증·재조회로 이미 끝난 일을 건너뛰므로 다시 실행해도 안전하다.
const AUTO_RESUME_ATTEMPTS = 12;

const TRANSIENT_FAILURE = /429|rate.?limit|timed out|시간 초과|HTTP 5\d\d|HTTP 599|relay|릴레이|disconnected|not connected/i;

export async function untilDone(job, label, step) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      const message = String(error?.message || error);
      if (job.cancelled || attempt >= AUTO_RESUME_ATTEMPTS || !TRANSIENT_FAILURE.test(message)) throw error;
      // 기본 5분에서 시작해 시도마다 늘어 최대 30분. 개발·시험에서는 환경 변수로 줄일 수 있다.
      const baseSeconds = CONFIG.resumeWaitSeconds;
      const waitSeconds = Math.min(baseSeconds * attempt, Math.max(baseSeconds, 1800));
      jobEvent(job, "rate-limit", `${label}: 일시적 실패(${message.slice(0, 80)}). ${formatDuration(waitSeconds)} 뒤 자동으로 이어서 진행합니다 (${attempt}/${AUTO_RESUME_ATTEMPTS}). 중단하려면 중단 버튼을 누르세요.`);
      await cancellableSleep(job, waitSeconds * 1000);
      jobEvent(job, "apply", `${label}: 다시 시도합니다.`);
    }
  }
}

const readPacer = createPacer();

export function relayApi(job, requestDelayMs = 1000) {
  return createRelayApi({ broker: relayBroker, requestDelayMs: CONFIG.requestDelayMs === undefined ? requestDelayMs : CONFIG.requestDelayMs,
    pacer: CONFIG.requestDelayMs === undefined ? readPacer : null,
    backoffBaseMs: CONFIG.relayBackoffMs, backoffCapMs: Math.max(CONFIG.relayBackoffMs, 300000), sleep: (ms) => cancellableSleep(job, ms),
    onRequest: ({ op, count }) => { if (job.cancelled) throw new Error("사용자가 중단했습니다"); jobEvent(job, "request", `ChatGPT 요청 #${count}: ${op}${job.currentItem ? ` — ${job.currentItem}` : ""}`); },
    onRelayDown: () => jobEvent(job, "relay-down", "ChatGPT 연결이 끊겼습니다. chatgpt.com 탭에서 북마클릿을 눌러 주세요. 연결되면 자동으로 이어서 진행합니다."),
    onRelayUp: ({ waitedMs }) => jobEvent(job, "relay-up", `ChatGPT 연결이 돌아왔습니다(${formatDuration(Math.round(waitedMs / 1000))} 기다림). 이어서 진행합니다.`),
    onRetry: (retry) => {
    const stage = retry.type === "http" && retry.status === 429 ? "rate-limit" : "retry";
    jobEvent(job, stage, retryMessage(retry));
  } });
}

// 재시도 안내 문구. 429 는 ChatGPT의 속도 제한에 맞춰 자동으로 조절하는 정상 동작임을 알린다.
export function retryMessage(retry) {
  const seconds = Math.round(retry.waitMs / 1000);
  if (retry.type === "http" && retry.status === 429) return `ChatGPT가 요청 속도를 제한했습니다(429). 자동으로 속도를 조절하는 중이라 정상입니다 — ${seconds}초 뒤 다시 시도합니다.`;
  if (retry.type === "http") return `ChatGPT 응답이 일시적으로 실패했습니다(HTTP ${retry.status}). ${seconds}초 뒤 다시 시도합니다(${retry.attempt}번째 재시도).`;
  return `연결이 잠시 끊겼습니다. ${seconds}초 뒤 다시 시도합니다(${retry.attempt}번째 재시도).`;
}

export async function relayAccountId(api) {
  const response = await api.accountInfo();
  assert(response.ok, `ChatGPT account lookup failed: HTTP ${response.status}`);
  const accountId = response.data?.accountId || "";
  assert(ACCOUNT_ID.test(accountId), "ChatGPT relay returned an invalid account ID");
  return accountId;
}

export function startAsyncJob(job, stage, task) {
  queueMicrotask(async () => {
    try {
      await task();
      job.ok = true;
    } catch (error) {
      job.ok = false;
      job.error = createSafeDiagnostic(stage, error, job.workspace, job.result?.run?.runId || null);
      jobEvent(job, "error", job.error.explain?.title || job.error.message);
    } finally {
      job.done = true;
      job.finishedAt = Date.now();
      job.log?.end(job);
    }
  });
}
