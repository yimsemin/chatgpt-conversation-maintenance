// 작업(스캔·적용) 실행 기반: 작업 목록·이벤트·진행률, 자동 재개, 릴레이 API 생성.
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { assert } from "./assert.js";
import { CONFIG } from "./config.js";
import { ACCOUNT_ID } from "./ids.js";
import { createRelayApi } from "./relay-api.js";
import { relayBroker } from "./remote-relay.js";
import { createJobLog, trackProgress, formatDuration } from "./jobs.js";
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

const TRANSIENT_STAGES = new Set(["progress", "rate-limit", "retry", "request"]);

export function jobEvent(job, stage, message) {
  // A "progress" event updates in place instead of piling up one line per
  // tick (e.g. one per downloaded conversation) — every other stage still
  // appends normally so the milestone log stays readable.
  const last = job.events[job.events.length - 1];
  // 429 재시도 알림도 같은 자리에 덮어써서 로그가 수백 줄로 늘지 않게 한다.
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

const SCAN_PROGRESS_LABELS = {
  projects: "프로젝트 목록 확인 중",
  active: "활성 대화 목록 확인 중",
  archived: "보관 대화 목록 확인 중",
  removed: "삭제된 대화 확인 중",
  downloads: "후보 대화 다운로드 중",
  drift: "최근 수정 대화 대조 중(간단 확인)",
  "apply-plan": "제목 변경·삭제 적용 중",
  routing: "프로젝트 배치 중",
};

export function formatScanProgress({ phase, index, total, projectName }) {
  const label = SCAN_PROGRESS_LABELS[phase] || phase;
  const unit = phase === "projects" ? "개" : "건";
  if (phase === "projects" && projectName) {
    return `${label}: ${projectName} (${index + 1}/${total}${unit})`;
  }
  if (Number.isFinite(total) && total > 0) {
    const percent = Math.min(100, Math.round((index / total) * 100));
    return `${label} (${index}/${total}${unit}, ${percent}%)`;
  }
  return `${label}${Number.isFinite(index) && index > 0 ? ` (${index}건)` : ""}`;
}

// 진행 정보를 로그 줄과 job.progress(단계·건수·남은 시간)에 함께 남긴다.
export function reportProgress(job, info) {
  const progress = trackProgress(job, { phase: info.phase, label: SCAN_PROGRESS_LABELS[info.phase] || info.phase,
    index: info.index, total: info.total });
  const eta = progress.etaSeconds ? ` · 남은 시간 약 ${formatDuration(progress.etaSeconds)}` : "";
  jobEvent(job, "progress", `${formatScanProgress(info)}${eta}`);
}

export function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    done: job.done,
    ok: job.ok,
    events: job.events,
    result: job.result,
    error: job.error,
    cancelled: job.cancelled === true,
    createdAt: job.createdAt,
    elapsedSeconds: Math.round(((job.finishedAt || Date.now()) - job.createdAt) / 1000),
    progress: job.progress ? {
      phase: job.progress.phase, label: job.progress.label, index: job.progress.index,
      total: job.progress.total, etaSeconds: job.progress.etaSeconds,
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
    onRequest: ({ op, count }) => { if (job.cancelled) throw new Error("사용자가 중단했습니다"); jobEvent(job, "request", `ChatGPT 요청 #${count}: ${op}`); }, onRetry: (retry) => {
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
