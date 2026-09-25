// 작업(스캔·적용) 로그를 파일에 남겨 화면을 닫거나 서버가 죽어도 상태를 복원한다.
// 작업마다 JSON Lines 파일 하나: 첫 줄 start, 이벤트들, 마지막 줄 end. end 가 없으면 중단된 작업이다.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_LINE = 2000;

export function computeEta({ startedAtMs, nowMs, index, total }) {
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(index) || index <= 0 || index >= total) return null;
  const elapsed = nowMs - startedAtMs;
  if (elapsed <= 0) return null;
  return Math.round(((total - index) * (elapsed / index)) / 1000);
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}초`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

// 진행 상황을 job.progress 에 기록한다. 단계가 바뀌면 시작 시각을 다시 잡는다.
export function trackProgress(job, { phase, label = phase, index = 0, total = null }, nowMs = Date.now()) {
  const previous = job.progress;
  const startedAtMs = previous && previous.phase === phase ? previous.startedAtMs : nowMs;
  job.progress = {
    phase, label, index, total,
    startedAtMs,
    updatedAtMs: nowMs,
    etaSeconds: computeEta({ startedAtMs, nowMs, index, total }),
  };
  return job.progress;
}

export function createJobLog(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pathOf = (job) => job.logFile;

  function write(file, entry) {
    try {
      appendFileSync(file, `${JSON.stringify(entry).slice(0, MAX_LINE * 4)}\n`, { mode: 0o600 });
    } catch {}
  }

  return {
    dir,
    open(job) {
      job.logFile = join(dir, `${new Date(job.createdAt).toISOString().replace(/[:.]/g, "-")}_${job.id.slice(0, 8)}.jsonl`);
      write(job.logFile, { type: "start", id: job.id, kind: job.kind, workspace: job.workspace, at: new Date(job.createdAt).toISOString() });
    },
    event(job, entry) {
      if (!job.logFile) return;
      write(pathOf(job), { type: "event", at: entry.at, stage: entry.stage, message: String(entry.message).slice(0, MAX_LINE) });
    },
    end(job) {
      if (!job.logFile) return;
      write(pathOf(job), { type: "end", at: new Date().toISOString(), ok: job.ok === true,
        error: job.error ? { code: job.error.code || null, message: String(job.error.message || "").slice(0, MAX_LINE), explain: job.error.explain || null } : null,
        cancelled: job.cancelled === true });
    },
    // 서버가 죽어 end 가 없는 작업을 중단됨으로 닫는다.
    closeInterrupted(activeIds = new Set()) {
      let closed = 0;
      for (const name of existsSync(dir) ? readdirSync(dir).filter((item) => item.endsWith(".jsonl")) : []) {
        const file = join(dir, name);
        const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
        const start = JSON.parse(lines[0] || "{}");
        if (activeIds.has(start.id)) continue;
        const last = JSON.parse(lines.at(-1) || "{}");
        if (last.type === "end") continue;
        write(file, { type: "end", at: new Date().toISOString(), ok: false, interrupted: true,
          error: { code: "INTERRUPTED", message: "서버가 종료되어 작업이 중단되었습니다. 같은 버튼으로 이어서 진행할 수 있습니다." } });
        closed += 1;
      }
      return closed;
    },
    // 최근 작업 요약(최신순). 이벤트 전문 대신 마지막 몇 줄만 돌려준다.
    recent(limit = 10, tail = 12) {
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort().reverse().slice(0, limit).map((name) => {
        const lines = readFileSync(join(dir, name), "utf8").trim().split("\n").filter(Boolean).map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
        const start = lines.find((line) => line.type === "start") || {};
        const end = lines.find((line) => line.type === "end") || null;
        const events = lines.filter((line) => line.type === "event");
        return {
          id: start.id || null, kind: start.kind || null, startedAt: start.at || null,
          finishedAt: end?.at || null, done: Boolean(end), ok: end ? end.ok === true : null,
          interrupted: end?.interrupted === true, error: end?.error || null,
          events: events.slice(-tail).map(({ at, stage, message }) => ({ at, stage, message })),
          eventCount: events.length,
        };
      });
    },
  };
}
