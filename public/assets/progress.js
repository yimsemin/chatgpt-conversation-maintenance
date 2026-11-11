// 진행 중 작업의 진행률·로그 블록과 적용 단계 표시.
import { S } from "/assets/state.js";
import { ask, clock, duration, fill, h } from "/assets/dom.js";
import { api, fail, post } from "/assets/net.js";

// 기본은 대화 단위 줄만 보여 주고, detail 이면 서버가 ChatGPT에 보낸 요청 줄까지 보여 준다.
const LOG_CLASS = { "rate-limit": "rl", "relay-down": "rl", retry: "rl", error: "er", "item-fail": "er", "item-skip": "rl" };
export const logLines = (events, detail = false) => events.filter((e) => detail || e.stage !== "request")
  .map((e) => h("div", { class: LOG_CLASS[e.stage] || "" }, `${clock(e.at)}  ${e.message}`));

// 종류별 누계 한 줄: 제목 변경 31건 · 프로젝트 이동 41건 · … / 본문 받음 20건 · 재활용 25건 · 건너뜀 1건
const COUNT_LABELS = [["rename", "제목 변경"], ["move", "프로젝트 이동"], ["trash", "삭제후보로 이동"], ["delete", "삭제"], ["fetch", "본문 받음"], ["reuse", "재활용"], ["skip", "건너뜀"], ["failed", "실패"]];
const countsText = (counts) => COUNT_LABELS.filter(([key]) => counts?.[key] > 0).map(([key, label]) => `${label} ${counts[key]}건`).join(" · ");

// 진행바 위 두 줄: 단계·전체 진행·남은 시간 / 지금 처리 중인 대화·경과 시간.
function statusLines(job) {
  const p = job.progress;
  if (job.waiting) return [`${job.waiting.stage === "relay-down" ? "연결 끊김" : "⏳ 대기 중"} — ${job.waiting.message}`, `경과 ${duration(job.elapsedSeconds)}`];
  if (!p) return ["준비 중", `경과 ${duration(job.elapsedSeconds)}`];
  const unit = p.phase === "projects" ? "개" : "건";
  const finishing = p.overallTotal > 0 && p.overallIndex >= p.overallTotal;
  const phase = finishing ? "변경 완료 · 검증·보고서 작성 중" : `${p.label}${p.total ? ` (${p.index}/${p.total}${unit})` : ""}`;
  const overall = !finishing && p.overallTotal > 0 ? `전체 ${Math.round(p.overallIndex / p.overallTotal * 100)}% (${p.overallIndex}/${p.overallTotal}건)` : "";
  return [[phase, overall, p.etaSeconds ? `남은 시간 약 ${duration(p.etaSeconds)}` : ""].filter(Boolean).join(" · "),
    [job.currentItem ? `지금: ${job.currentItem}` : "", `경과 ${duration(job.elapsedSeconds)}`].filter(Boolean).join(" · ")];
}

export function progressBlock(kind) {
  const bar = h("i"); const barWrap = h("div", { class: "bar" }, bar);
  const label = h("p", { class: "small" }); const sub = h("p", { class: "muted small" }); const counts = h("p", { class: "small" });
  const log = h("pre", { class: "log" });
  const cancel = h("button", { class: "btn ghost", type: "button", onclick: async () => {
    if (!await ask({ title: "작업을 중단할까요?", lines: ["이미 끝난 부분은 유지되고, 같은 버튼으로 이어서 진행할 수 있습니다."], ok: "중단" })) return;
    try { await post("/maintenance/cancel", { jobId: S.session.job.id }); } catch (e) { fail(e); }
  } }, "중단");
  let full = false;
  const hint = h("span", { class: "muted small", text: "최근 200줄만 보입니다." });
  const fullBtn = h("button", { class: "btn link", type: "button", onclick: async () => {
    full = !full; fullBtn.textContent = full ? "간단히 보기" : "상세 기록 보기"; hint.textContent = full ? "작업 시작부터 서버 요청 줄까지 모두 보입니다(자동 갱신 안 함)." : "최근 200줄만 보입니다.";
    if (!full) return;
    try { const r = await api(`/maintenance/job-log?id=${encodeURIComponent(S.session.job.id)}`); fill(log, ...logLines(r.events, true)); log.scrollTop = log.scrollHeight; } catch (e) { fail(e); full = false; fullBtn.textContent = "상세 기록 보기"; hint.textContent = "최근 200줄만 보입니다."; }
  } }, "상세 기록 보기");
  const box = h("div", {}, barWrap, label, sub, counts, h("div", { class: "row" }, cancel), log, h("div", { class: "row" }, hint, fullBtn));
  S.live.push(() => {
    const job = S.session?.job;
    if (!job) { label.textContent = ""; return; }
    const p = job.progress;
    const [pct, whole] = p?.overallTotal > 0 ? [p.overallIndex / p.overallTotal, true] : p?.total > 0 ? [p.index / p.total, false] : [null, false];
    barWrap.classList.toggle("waiting", Boolean(job.waiting));
    if (pct !== null) {
      barWrap.classList.remove("indeterminate");
      // 마지막 검증·보고서 작성이 남아 있는 동안은 100%로 보이지 않게 한다.
      bar.style.width = `${Math.min(whole && !job.done ? 99 : 100, Math.round(pct * 100))}%`;
    } else barWrap.classList.add("indeterminate");
    const [line1, line2] = statusLines(job);
    label.textContent = line1; sub.textContent = line2; counts.textContent = countsText(job.counts);
    if (full) return;
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
    fill(log, ...logLines(job.events.slice(-200)));
    if (stick) log.scrollTop = log.scrollHeight;
  });
  return box;
}

const APPLY_STAGES = [["apply", "제목 변경·삭제"], ["routing", "프로젝트 이동"], ["verify", "변경 검증"], ["report", "보고서 작성"]];

export function applyStages() {
  const list = h("p", { class: "substeps" });
  S.live.push(() => {
    const events = S.session?.job?.events || [];
    const stages = events.map((e) => e.stage);
    const idx = Math.max(-1, ...APPLY_STAGES.map(([id], i) => stages.lastIndexOf(id) >= 0 ? i : -1));
    fill(list, ...APPLY_STAGES.map(([, label], i) => h("span", { class: i < idx ? "done" : i === idx ? "current" : "" }, label)));
  });
  return list;
}

const SCAN_STAGES = [["projects", "프로젝트 목록"], ["lists", "대화 목록"], ["downloads", "본문 받기"], ["review", "분류 입력 준비"]];
const SCAN_PHASE_STAGE = { projects: 0, active: 1, archived: 1, downloads: 2 };

// 수집 단계 표시. 범위에 따라 프로젝트 목록을 읽지 않으면 그 단계는 숨긴다.
export function scanStages() {
  const list = h("p", { class: "substeps" });
  S.live.push(() => {
    const job = S.session?.job;
    const events = job?.events || [];
    const idx = events.some((e) => e.stage === "review" || e.stage === "ready") ? 3 : SCAN_PHASE_STAGE[job?.progress?.phase] ?? -1;
    const readsProjects = idx <= 0 || events.some((e) => e.stage === "item" && e.message.includes("프로젝트 읽음"));
    fill(list, ...SCAN_STAGES.map(([id, label], i) => (i === 0 && !readsProjects ? null
      : h("span", { class: i < idx ? "done" : i === idx ? "current" : "" }, label))).filter(Boolean));
  });
  return list;
}
