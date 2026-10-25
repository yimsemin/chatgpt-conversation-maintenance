// 화면 시작점: 세션 상태에 따라 위쪽 카드·단계 표시·패널을 그린다.
import { startRelay } from "/assets/relay-client.js";
import { S, STEPS, hooks } from "/assets/state.js";
import { $, ask, duration, fill, h, meta, when } from "/assets/dom.js";
import { api, fail, post, toast } from "/assets/net.js";
import { currentStep, refreshSession, schedulePoll } from "/assets/session-client.js";
import { applyStages, progressBlock } from "/assets/progress.js";
import { applyReadyPanel, loadScope, scanPanel, scopeLabel, startScan } from "/assets/panel-scan.js";
import { renderGuide, stepHint } from "/assets/help.js";
import { proposalPanel } from "/assets/panel-proposal.js";
import { loadReview } from "/assets/panel-review.js";
import { loadResult } from "/assets/panel-result.js";
import { loadTrash } from "/assets/panel-trash.js";
import { initChangelog } from "/assets/changelog.js";

const BOOTED_AT = Date.now();

function render() {
  const s = S.session;
  const reachable = Boolean(S.sessionError?.detail);
  const outdated = S.relayLocal?.needsUpdate === true;
  // 북마클릿으로 막 연 창은 ChatGPT와 연결하는 데 몇 초 걸린다. 그동안은 "끊김"이 아니라 "연결 중"으로 보인다.
  const connecting = isRelayOwnerWindow() && s && !s.relay?.connected && Date.now() - BOOTED_AT < 20000;
  const relay = connecting ? { level: "warn", label: "ChatGPT에 연결하는 중…", hint: "" } : outdated ? { level: "bad", label: "북마클릿 업데이트 필요", hint: "chatgpt.com의 북마클릿이 이 앱보다 오래됐습니다. 북마클릿을 다시 설치한 뒤 눌러 주세요." }
    : s?.relay || (reachable ? { level: "warn", label: "앱이 오류를 응답했습니다", hint: "" }
      : { level: "bad", label: "서버 응답 없음", hint: "앱 서버가 실행 중인지 확인하세요." });
  $("relay-pill").className = `pill ${relay.level}`;
  $("relay-label").textContent = relay.label;
  const hint = $("relay-hint");
  // 분류 제안을 기다리는 단계는 ChatGPT 연결이 필요 없으므로 연결 안내를 숨긴다.
  hint.hidden = !relay.hint || currentStep() === "proposal"; hint.textContent = relay.hint || "";
  if (relay.hint && s && !s.relay?.connected) {
    hint.append(" ", h("a", { href: "/auth/bookmarklet", target: "_blank", rel: "noopener", text: "북마클릿 설치 안내" }));
  }
  // 정리 창 하나로 통합했다: 북마클릿이 여는 창이 정리 화면이면서 ChatGPT 연결도 맡는다.
  const note = $("relay-note");
  const owner = isRelayOwnerWindow();
  note.hidden = !s?.relay?.connected;
  note.textContent = owner
    ? "이 창이 ChatGPT와 연결되어 있습니다. 작업이 끝날 때까지 이 창과 chatgpt.com 탭을 닫지 마세요."
    : "ChatGPT 연결은 북마클릿으로 연 정리 창이 맡고 있습니다. 그 창을 닫으면 연결이 끊깁니다.";
  renderAppInfo();
  renderTitle();
  renderFailure();
  renderNow();
  renderSteps();
  const step = currentStep();
  const key = `${step}:${Boolean(s?.relay?.connected)}:${s?.run?.id || ""}:${s?.run?.hasProposal}:${s?.job?.id || ""}:${s?.report?.finishedAt || ""}`;
  if (key !== S.panelKey) { S.panelKey = key; S.live = []; buildPanel(step); }
  for (const update of S.live) update();
  renderRecent();
}

// 지금 돌고 있는 앱 프로세스를 항상 보여 준다: 무엇이 돌고 있는지, 어떻게 끄는지, 시작한 뒤 코드가 바뀌었는지.
function renderAppInfo() {
  const box = $("app-info"); const app = S.session?.app;
  if (!app) { box.hidden = true; return; }
  box.hidden = false;
  const since = duration(app.uptimeSeconds);
  box.textContent = `● 앱 실행 중 (프로세스 ${app.pid}, ${since} 전 시작) · 끄려면 앱을 켠 터미널 창을 닫거나 Ctrl+C. 이 탭을 닫아도 앱은 계속 실행됩니다.`;
  if (app.codeChanged) box.textContent += " ⚠ 시작한 뒤 코드가 바뀌었으니 다시 켜세요.";
}

// 가장 최근 작업이 실패했고 그 뒤에 성공이 없으면 원인과 조치를 화면 맨 위에 보인다.
function renderFailure() {
  const last = S.session?.recentJobs?.[0]; const box = $("failure");
  const show = last && last.done && !last.ok && !S.dismissed.has(last.id) && !(S.session.job && !S.session.job.done);
  if (!show) { box.hidden = true; return; }
  const explain = last.error?.explain || { title: last.error?.message || "작업이 실패했습니다", action: "" };
  const message = last.error?.message || "";
  // 제목과 원문이 같으면 한 번만 복사한다.
  const copyText = [explain.title, message && message !== explain.title ? message : "", `작업: ${last.kind} ${last.startedAt || ""}`].filter(Boolean).join("\n");
  fill(box, h("strong", { text: explain.title }), h("p", { class: "small", text: explain.action }),
    h("div", { class: "row" },
      explain.recovery === "rescan" ? h("button", { class: "btn", type: "button", disabled: !S.session.relay?.connected, onclick: async () => { S.dismissed.add(last.id); S.forceStep = null; S.view = null; if (S.session.run?.scope) { S.scope = { ...S.scope, ...S.session.run.scope }; } await startScan(); } }, "같은 범위를 다시 수집") : null,
      h("button", { class: "btn ghost", type: "button", onclick: (e) => { navigator.clipboard.writeText(copyText); e.target.textContent = "복사됨"; } }, "오류 복사"),
      h("button", { class: "btn ghost", type: "button", onclick: () => { S.dismissed.add(last.id); render(); } }, "닫기")));
  box.hidden = false;
}

// 탭 제목에 상태를 넣어 다른 탭에서도 진행·완료를 알아볼 수 있게 한다. ChatGPT 연결을 맡은 정리 창은 연결 상태를 제목 앞에 붙인다.
function renderTitle() {
  const job = S.session?.job; const step = currentStep();
  const link = isRelayOwnerWindow() ? (S.session?.relay?.connected ? "🔗 " : "⚠ 연결 끊김 · ") : "";
  document.title = link + (job && !job.done ? `(진행 중${job.progress?.etaSeconds ? ` · ${duration(job.progress.etaSeconds)}` : ""}) 대화 정리`
    : step === "review" ? "(검토 필요) 대화 정리" : step === "result" ? "(완료) 대화 정리" : "대화 정리");
}

// 북마클릿이 연 창(ChatGPT 탭이 열어 준 창)인가. 이 창이 ChatGPT와의 연결을 맡는다.
function isRelayOwnerWindow() { return window.name === "chatgptMaintenance" && Boolean(window.opener); }

// 이 정리를 두고 다른 범위를 고르러 간다(새 수집을 시작하기 전에는 아무것도 버려지지 않는다).
function restartButton() {
  return h("button", { class: "btn ghost", type: "button", onclick: () => { S.forceStep = "scan"; S.view = null; S.panelKey = ""; render(); } }, "범위 다시 고르기");
}

function renderNow() {
  const s = S.session; const step = currentStep(); const job = s?.job;
  if (!s) {
    const reachable = Boolean(S.sessionError?.detail);
    fill($("now"), h("div", {}, h("p", { class: "headline", text: reachable ? "앱이 오류를 응답했습니다" : "앱에 연결하지 못했습니다" }),
      h("p", { class: "sub", text: reachable ? (S.sessionError.detail.explain?.title || S.sessionError.message) : "터미널에서 `npm run app`으로 앱을 켠 뒤 새로고침하세요." })));
    return;
  }
  let headline = "수집 중…"; let sub = ""; let action = null;
  if (job && !job.done) {
    headline = job.kind === "apply" ? "적용 중입니다" : "수집 중입니다";
    sub = job.progress ? `${job.progress.label}${job.progress.etaSeconds ? ` · 남은 시간 약 ${duration(job.progress.etaSeconds)}` : ""}` : "잠시만 기다려 주세요";
  } else if (step === "trash") {
    headline = "삭제후보 확인"; sub = `「${s.trash?.project || "?"}」의 대화를 삭제하거나 복원하세요.`;
    action = h("button", { class: "btn ghost", type: "button", onclick: () => { S.view = null; S.panelKey = ""; render(); } }, "돌아가기");
  } else if (step === "scan") {
    const allClear = s.run?.phase === "complete" && s.run.candidates === 0 && !s.run.hasReport;
    headline = allClear ? "이 범위에는 정리할 대화가 없습니다" : "수집할 범위를 고르세요";
    sub = s.run ? `마지막 수집 ${when(s.run.updatedAt)}` : "아직 수집한 기록이 없습니다";
  } else if (step === "proposal") {
    headline = `후보 ${s.run?.candidates ?? "?"}건의 분류가 필요합니다`; sub = `${scopeLabel(s.run?.scope)} · ${when(s.run?.updatedAt)} 수집 · AI 에이전트에게 분류를 맡기세요.`;
    action = restartButton();
  } else if (step === "review") {
    headline = "분류 제안을 검토하세요"; sub = `${scopeLabel(s.run?.scope)} · 후보 ${s.run?.candidates ?? "?"}건 · ${when(s.run?.updatedAt)} 수집`;
    action = restartButton();
  } else if (step === "result") {
    headline = s.report?.headline || "정리가 끝났습니다"; sub = `${when(s.report?.finishedAt)} 완료`;
    action = h("button", { class: "btn ghost", type: "button", onclick: () => { S.forceStep = "scan"; S.panelKey = ""; render(); } }, "새 정리 시작");
  }
  fill($("now"), h("div", {}, h("p", { class: "headline", text: headline }), h("p", { class: "sub", text: sub })), action);
}

function renderSteps() {
  $("steps").hidden = currentStep() === "trash";
  const order = STEPS.map(([id]) => id); const at = order.indexOf(currentStep());
  fill($("steps"), ...STEPS.map(([id, label], i) =>
    h("li", { class: i < at ? "done" : i === at ? "current" : "", title: stepHint(id) }, h("b", { text: `${i + 1}` }), h("span", { class: "lbl", text: label }))));

}

function buildPanel(step) {
  const panel = $("panel"); fill(panel);
  const s = S.session;
  if (!s) { panel.append(h("p", { class: "muted", text: "앱 서버에 연결하는 중입니다…" })); return; }
  if (s.job && !s.job.done) {
    fill(panel, s.job.kind === "apply" ? applyStages() : null, progressBlock(s.job.kind));
    return;
  }
  if (step === "scan") panel.append(scanPanel());
  else if (step === "proposal") panel.append(proposalPanel());
  else if (step === "review") { panel.append(h("p", { class: "muted", text: "검토 내용을 불러오는 중…" })); loadReview(); }
  else if (step === "result") { panel.append(h("p", { class: "muted", text: "결과를 불러오는 중…" })); loadResult(); }
  else if (step === "trash") { panel.append(h("p", { class: "muted", text: "삭제후보 목록을 불러오는 중…" })); loadTrash(); }
  else if (step === "apply") panel.append(applyReadyPanel());
  else panel.append(scanPanel());
}

// ---------- recent jobs ----------
function renderRecent() {
  const jobs = S.session?.recentJobs || [];
  fill($("recent"), ...(jobs.length ? jobs.map((j) => h("div", { class: "job" },
    h("strong", { text: `${j.kind === "apply" ? "적용" : "수집"} · ${when(j.startedAt)} · ${!j.done ? "진행 중" : j.ok ? "성공" : j.interrupted ? "중단됨" : "실패"}` }),
    j.error ? h("div", { class: "muted", text: j.error.message }) : h("div", { class: "muted", text: j.events.at(-1)?.message || "" }))) : [h("p", { class: "muted", text: "기록이 없습니다." })]));
}

// ---------- boot ----------
async function boot() {
  hooks.render = render;
  $("theme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next; try { localStorage.setItem("maintenance_theme", next); } catch {}
  });
  $("relay-pill").addEventListener("click", () => { const hint = S.session?.relay?.hint; if (hint) toast(S.session.relay.label, hint); });
  renderGuide();
  // 아래쪽 탭: 사용 안내 / 최근 작업 / 고급. 같은 탭을 다시 누르면 접힌다.
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      const open = !tab.classList.contains("on");
      for (const other of document.querySelectorAll(".tab")) other.classList.toggle("on", open && other === tab);
      for (const panel of document.querySelectorAll(".tabpanel")) panel.hidden = !(open && panel.id === `tab-${tab.dataset.tab}`);
    });
  }
  $("recent-clear").addEventListener("click", async () => {
    if (!await ask({ title: "최근 작업 기록을 지울까요?", lines: ["이 컴퓨터에 저장된 기록만 지웁니다. 정리 결과와 ChatGPT의 대화는 그대로입니다."], ok: "지우기" })) return;
    try { const r = await post("/maintenance/jobs/clear"); toast("최근 작업을 지웠습니다", `${r.removed}건`); await refreshSession(); } catch (e) { fail(e); }
  });
  $("app-stop").addEventListener("click", async () => {
    if (!await ask({ title: "앱을 종료할까요?", lines: ["이 화면은 더 이상 동작하지 않습니다. 다시 쓰려면 터미널에서 npm run app 을 실행하세요."], ok: "종료" })) return;
    try {
      const response = await fetch("/app/shutdown", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { toast("종료하지 못했습니다", body?.error?.message || `HTTP ${response.status}`); return; }
      document.body.innerHTML = "<main><h1>앱이 종료되었습니다</h1><p>이 탭과 앱을 켰던 터미널 창을 닫아도 됩니다. 다시 쓰려면 터미널에서 <code>npm run app</code> 을 실행하세요.</p></main>";
    } catch (e) { toast("종료하지 못했습니다", String(e?.message || e)); }
  });
  const config = await api("/config").catch(() => ({}));
  loadScope();
  // 삭제후보 처리 방식의 기본값은 설정 파일(.local/config.json)에서 오고, 화면에서 고른 값이 있으면 그것이 우선한다.
  S.trashDefault = config.trash?.defaultName || "삭제후보";
  S.trash = { mode: config.trash?.mode || "auto", name: config.trash?.name || S.trashDefault, permanent: false };
  try {
    const saved = JSON.parse(localStorage.getItem("app_trash") || "null");
    if (saved && ["auto", "fixed", "none"].includes(saved.mode)) S.trash = { ...S.trash, mode: saved.mode, ...(saved.name ? { name: saved.name } : {}) };
  } catch {}
  // 북마클릿이 연 창은 연결만 맡는다. 작업 화면을 둘로 나누면 어디서 눌러야 할지 헷갈리고 동시에 두 곳에서 작업을 시작할 수 있다.
  initChangelog();
  startRelay({ api, relayVersion: meta("relay-version"), onState: (state) => { S.relayLocal = state; refreshSession(); } });
  await refreshSession();
  schedulePoll();
}
boot();
