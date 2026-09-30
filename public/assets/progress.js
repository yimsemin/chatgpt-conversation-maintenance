// 진행 중 작업의 진행률·로그 블록과 적용 단계 표시.
import { S } from "/assets/state.js";
import { ask, clock, duration, fill, h } from "/assets/dom.js";
import { fail, post } from "/assets/net.js";

export function progressBlock(kind) {
  const bar = h("i"); const barWrap = h("div", { class: "bar" }, bar);
  const label = h("p", { class: "small" }); const log = h("pre", { class: "log" });
  const cancel = h("button", { class: "btn ghost", type: "button", onclick: async () => {
    if (!await ask({ title: "작업을 중단할까요?", lines: ["이미 끝난 부분은 유지되고, 같은 버튼으로 이어서 진행할 수 있습니다."], ok: "중단" })) return;
    try { await post("/maintenance/cancel", { jobId: S.session.job.id }); } catch (e) { fail(e); }
  } }, "중단");
  const box = h("div", {}, barWrap, label, h("div", { class: "row" }, cancel), log);
  S.live.push(() => {
    const job = S.session?.job;
    if (!job) { label.textContent = ""; return; }
    const p = job.progress;
    if (p?.total > 0) { barWrap.classList.remove("indeterminate"); bar.style.width = `${Math.min(100, Math.round(p.index / p.total * 100))}%`; }
    else barWrap.classList.add("indeterminate");
    label.textContent = [p ? `${p.label}${p.total ? ` (${p.index}/${p.total}${p.phase === "projects" ? "개" : "건"})` : ""}` : "준비 중", p?.etaSeconds ? `남은 시간 약 ${duration(p.etaSeconds)}` : "", `경과 ${duration(job.elapsedSeconds)}`].filter(Boolean).join(" · ");
    fill(log, ...job.events.slice(-10).map((e) => h("div", { class: e.stage === "rate-limit" ? "rl" : e.stage === "error" ? "er" : "" }, `${clock(e.at)}  ${e.message}`)));
    log.scrollTop = log.scrollHeight;
  });
  return box;
}

const APPLY_STAGES = [["apply", "제목 변경·삭제"], ["routing", "프로젝트 이동"], ["verify", "변경 검증"], ["report", "보고서 작성"]];

export function applyStages() {
  const list = h("ol", { class: "steps" });
  S.live.push(() => {
    const events = S.session?.job?.events || [];
    const stages = events.map((e) => e.stage);
    const idx = Math.max(-1, ...APPLY_STAGES.map(([id], i) => stages.lastIndexOf(id) >= 0 ? i : -1));
    fill(list, ...APPLY_STAGES.map(([, label], i) => h("li", { class: i < idx ? "done" : i === idx ? "current" : "" }, label)));
  });
  return list;
}
