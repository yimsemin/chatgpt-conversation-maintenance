// 화면 시작점: 세션 상태에 따라 위쪽 카드·단계 표시·패널을 그린다.
import { errorExplanation, eventText, progressLabel, t } from "/assets/language.js";
import { startRelay } from "/assets/relay-client.js";
import { S, STEPS, hooks } from "/assets/state.js";
import { $, ask, dotted, duration, fill, h, meta, when } from "/assets/dom.js";
import { api, fail, post, toast } from "/assets/net.js";
import { currentStep, refreshSession, schedulePoll } from "/assets/session-client.js";
import { applyStages, logLines, progressBlock, scanStages } from "/assets/progress.js";
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
  const language = $("language");
  language.disabled = Boolean((s?.job && !s.job.done) || (s?.lock && !s.lock.stale));
  language.title = language.disabled ? t("app.languageDuringJob") : "";
  const reachable = Boolean(S.sessionError?.detail);
  const outdated = S.relayLocal?.needsUpdate === true;
  // 북마클릿으로 막 연 창은 ChatGPT와 연결하는 데 몇 초 걸린다. 그동안은 "끊김"이 아니라 "연결 중"으로 보인다.
  const connecting = isRelayOwnerWindow() && s && !s.relay?.connected && Date.now() - BOOTED_AT < 20000;
  // 겉모습만 바뀐 새 북마클릿이 있으면 연결은 유지하되 선택적 갱신을 안내한다.
  const softUpdate = S.relayLocal?.updateAvailable === true && s?.relay?.connected === true;
  const relay = connecting ? { level: "warn", label: t("app.connectingChatgpt"), hint: "" } : outdated ? { level: "bad", label: t("app.bookmarkletOutdated"), hint: t("app.bookmarkletOutdatedHint") }
    : softUpdate ? { ...s.relay, hint: t("app.bookmarkletUpdateAvailable") }
    : s?.relay || (reachable ? { level: "warn", label: t("app.serverError"), hint: "" }
      : { level: "bad", label: t("app.noServerResponse"), hint: t("app.checkServerRunning") });
  $("relay-pill").className = `pill ${relay.level}`;
  $("relay-label").textContent = relay.label;
  const hint = $("relay-hint");
  // 분류 제안을 기다리는 단계는 ChatGPT 연결이 필요 없으므로 연결 안내를 숨긴다.
  hint.hidden = !relay.hint || currentStep() === "proposal"; hint.textContent = relay.hint || "";
  if (relay.hint && s && (!s.relay?.connected || softUpdate)) {
    hint.append(" ", h("a", { href: "/auth/bookmarklet", target: "_blank", rel: "noopener", text: t("app.installBookmarklet") }));
  }
  // 정리 창 하나로 통합했다: 북마클릿이 여는 창이 정리 화면이면서 ChatGPT 연결도 맡는다.
  const note = $("relay-note");
  const owner = isRelayOwnerWindow();
  // 연결 안내는 작업이 도는 동안만 줄로 보이고, 평소에는 연결 표시(pill)의 설명으로만 둔다.
  const noteText = owner
    ? t("app.thisWindowConnects")
    : t("app.relayWindowNote");
  note.hidden = !(s?.relay?.connected && s.job && !s.job.done);
  note.textContent = noteText;
  $("relay-pill").title = s?.relay?.connected ? noteText : "";
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
  // 항목마다 한 덩어리로 묶어 줄이 바뀔 때 항목 사이에서만 끊는다. 끄는 방법은 도움말 탭에 있다.
  const parts = [t("app.running"), t("app.processPid", { pid: app.pid }), t("app.startedAgo", { elapsed: since })];
  if (app.codeChanged) parts.push(t("app.codeChangedRestart"));
  fill(box, h("i", { class: "dot" }), ...parts.map((text) => h("span", { text })));
  box.title = t("app.keepsRunningHint");
}

// 가장 최근 작업이 실패했고 그 뒤에 성공이 없으면 원인과 조치를 화면 맨 위에 보인다.
function renderFailure() {
  const last = S.session?.recentJobs?.[0]; const box = $("failure");
  const show = last && last.done && !last.ok && !S.dismissed.has(last.id) && !(S.session.job && !S.session.job.done);
  if (!show) { box.hidden = true; return; }
  const explain = errorExplanation(last.error) || { title: last.error?.message || t("app.jobFailed"), action: "" };
  const message = last.error?.message || "";
  // 제목과 원문이 같으면 한 번만 복사한다.
  const copyText = [explain.title, message && message !== explain.title ? message : "", t("app.job", { kind: last.kind, when: last.startedAt || "" })].filter(Boolean).join("\n");
  fill(box, h("strong", { text: explain.title }), h("p", { class: "small", text: explain.action }),
    h("div", { class: "row" },
      explain.recovery === "rescan" ? h("button", { class: "btn", type: "button", disabled: !S.session.relay?.connected, onclick: async () => { S.dismissed.add(last.id); S.forceStep = null; S.view = null; if (S.session.run?.scope) { S.scope = { ...S.scope, ...S.session.run.scope }; } await startScan(); } }, t("app.collectSameScope")) : null,
      h("button", { class: "btn ghost", type: "button", onclick: (e) => { navigator.clipboard.writeText(copyText); e.target.textContent = t("app.copied"); } }, t("app.copy.error")),
      h("button", { class: "btn ghost", type: "button", onclick: () => { S.dismissed.add(last.id); render(); } }, t("app.close"))));
  box.hidden = false;
}

// 탭 제목에 상태를 넣어 다른 탭에서도 진행·완료를 알아볼 수 있게 한다. ChatGPT 연결을 맡은 정리 창은 연결 상태를 제목 앞에 붙인다.
function renderTitle() {
  const job = S.session?.job; const step = currentStep();
  const link = isRelayOwnerWindow() ? (S.session?.relay?.connected ? "🔗 " : t("app.disconnected")) : "";
  document.title = link + (job && !job.done ? t("app.titleInProgress", { eta: job.progress?.etaSeconds ? ` · ${duration(job.progress.etaSeconds)}` : "" })
    : step === "review" ? t("app.titleReviewNeeded") : step === "result" ? t("app.titleComplete") : t("app.name"));
}

// 북마클릿이 연 창(ChatGPT 탭이 열어 준 창)인가. 이 창이 ChatGPT와의 연결을 맡는다.
function isRelayOwnerWindow() { return window.name === "chatgptMaintenance" && Boolean(window.opener); }

// 이 정리를 두고 다른 범위를 고르러 간다(새 수집을 시작하기 전에는 아무것도 버려지지 않는다).
function restartButton() {
  return h("button", { class: "btn ghost", type: "button", onclick: () => { S.forceStep = "scan"; S.view = null; S.panelKey = ""; render(); } }, t("app.chooseOtherScope"));
}

function renderNow() {
  const s = S.session; const step = currentStep(); const job = s?.job;
  if (!s) {
    const reachable = Boolean(S.sessionError?.detail);
    fill($("now"), h("div", {}, h("p", { class: "headline", text: reachable ? t("app.serverError") : t("app.serverUnreachable") }),
      h("p", { class: "sub", text: reachable ? (errorExplanation(S.sessionError.detail)?.title || S.sessionError.message) : t("app.runNpmApp") })));
    return;
  }
  let headline = t("app.collecting"); let sub = ""; let action = null;
  if (job && !job.done) {
    headline = job.kind === "apply" ? t("app.applying.changes") : t("app.collectingTitle");
    sub = job.progress ? `${progressLabel(job.progress)}${job.progress.etaSeconds ? t("app.about.remaining", { remaining: duration(job.progress.etaSeconds) }) : ""}` : t("app.please.wait");
  } else if (step === "trash") {
    headline = t("app.reviewTrash"); sub = t("app.trashDeleteOrRestore", { project: s.trash?.project || "?" });
    action = h("button", { class: "btn ghost", type: "button", onclick: () => { S.view = null; S.panelKey = ""; render(); } }, t("app.back"));
  } else if (step === "scan") {
    const allClear = s.run?.phase === "complete" && s.run.candidates === 0 && !s.run.hasReport;
    headline = allClear ? t("app.nothingToClean") : t("app.chooseScope");
    sub = s.run ? t("app.last.collection", { when: when(s.run.updatedAt) }) : t("app.noCollectionHistory");
  } else if (step === "proposal") {
    headline = t("app.needsClassification", { count: s.run?.candidates ?? "?" }); sub = t("app.collectedAskAgent", { scope: scopeLabel(s.run?.scope), when: when(s.run?.updatedAt) });
    action = restartButton();
  } else if (step === "review") {
    headline = t("app.reviewProposal"); sub = t("app.candidates.collected", { scope: scopeLabel(s.run?.scope), count: s.run?.candidates ?? "?", when: when(s.run?.updatedAt) });
    action = restartButton();
  } else if (step === "result") {
    headline = s.report?.headline || t("app.cleanupComplete"); sub = t("app.finished", { when: when(s.report?.finishedAt) });
    action = h("button", { class: "btn ghost", type: "button", onclick: () => { S.forceStep = "scan"; S.panelKey = ""; render(); } }, t("app.startNewCleanup"));
  }
  fill($("now"), h("div", {}, h("p", { class: "headline" }, ...dotted(headline)), h("p", { class: "sub" }, ...dotted(sub))), action);
}

function renderSteps() {
  $("steps").hidden = currentStep() === "trash";
  const order = STEPS.map(([id]) => id); const at = order.indexOf(currentStep());
  fill($("steps"), ...STEPS.map(([id, label], i) =>
    h("li", { class: i < at ? "done" : i === at ? "current" : "", title: stepHint(id) }, h("b", { text: i < at ? "✓" : `${i + 1}` }), h("span", { class: "lbl", text: label }))));

}

function buildPanel(step) {
  const panel = $("panel"); fill(panel);
  const s = S.session;
  if (!s) { panel.append(h("p", { class: "muted", text: t("app.connectingServer") })); return; }
  if (s.job && !s.job.done) {
    fill(panel, s.job.kind === "apply" ? applyStages() : s.job.kind === "scan" ? scanStages() : null, progressBlock(s.job.kind));
    return;
  }
  if (step === "scan") panel.append(scanPanel());
  else if (step === "proposal") panel.append(proposalPanel());
  else if (step === "review") { panel.append(h("p", { class: "muted", text: t("app.loading.review") })); loadReview(); }
  else if (step === "result") { panel.append(h("p", { class: "muted", text: t("app.loading.results") })); loadResult(); }
  else if (step === "trash") { panel.append(h("p", { class: "muted", text: t("app.loadingTrash") })); loadTrash(); }
  else if (step === "apply") panel.append(applyReadyPanel());
  else panel.append(scanPanel());
}

// ---------- recent jobs ----------
const openLogs = new Map(); // 펼친 작업 id → 불러온 전체 기록(화면이 다시 그려져도 펼친 채로 둔다)

function renderRecent() {
  const jobs = S.session?.recentJobs || [];
  fill($("recent"), ...(jobs.length ? jobs.map((j) => h("div", { class: "job" },
    h("strong", { text: `${j.kind === "apply" ? t("app.apply") : t("app.collect")} · ${when(j.startedAt)} · ${!j.done ? t("app.in.progress") : j.ok ? t("app.succeeded") : j.interrupted ? t("app.interrupted") : t("app.failed")}` }),
    j.error ? h("div", { class: "muted", text: errorExplanation(j.error)?.title || j.error.message }) : h("div", { class: "muted", text: eventText(j.events.at(-1)) }),
    h("button", { class: "btn link", type: "button", onclick: async () => {
      if (openLogs.has(j.id)) openLogs.delete(j.id);
      else { try { openLogs.set(j.id, (await api(`/maintenance/job-log?id=${encodeURIComponent(j.id)}`)).events); } catch (err) { fail(err); return; } }
      renderRecent();
    } }, openLogs.has(j.id) ? t("app.collapse.log") : t("app.viewFullLog")),
    openLogs.has(j.id) ? h("pre", { class: "log" }, ...logLines(openLogs.get(j.id))) : null)) : [h("p", { class: "muted", text: t("app.no.records") })]));
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
    if (!await ask({ title: t("app.clearRecentConfirm"), lines: [t("app.recentClearNote")], ok: t("app.clear") })) return;
    try { const r = await post("/maintenance/jobs/clear"); toast(t("app.recentCleared"), t("app.records.removed", { count: r.removed })); await refreshSession(); } catch (e) { fail(e); }
  });
  $("app-stop").addEventListener("click", async () => {
    if (!await ask({ title: t("app.stopConfirm"), lines: [t("app.pageStopped")], ok: t("app.stop.app") })) return;
    try {
      await post("/app/shutdown");
      fill(document.body, h("main", {}, h("h1", { text: t("app.stoppedTitle") }), h("p", { text: t("app.stoppedHint") })));
    } catch (e) { toast(t("app.stopFailed"), String(e?.message || e)); }
  });
  const config = await api("/config").catch(() => ({}));
  loadScope();
  // 삭제후보 처리 방식의 기본값은 설정 파일(.local/config.json)에서 오고, 화면에서 고른 값이 있으면 그것이 우선한다.
  S.trashDefault = config.trash?.defaultName || t("common.trashProject");
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
