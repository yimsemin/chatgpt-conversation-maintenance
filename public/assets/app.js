import { startRelay } from "/assets/relay-client.js";
import { buildReviewSummary, rowsFromProposal } from "/assets/shared/summary.js";
import { isNormalizedTitle } from "/assets/shared/title-rules.js";

const $ = (id) => document.getElementById(id);
const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content || "";
const STEPS = [["scan", "확인"], ["proposal", "제안"], ["review", "검토"], ["apply", "적용"], ["result", "결과"]];

const S = {
  workspace: "", session: null, catalog: null, proposal: null, overrides: new Map(),
  forceStep: null, panelKey: "", live: [], quiet: true, relayLocal: { connected: false },
  lastScanEmpty: null, view: null, parking: null, dismissed: new Set(),
  parkingProject: (() => { try { return localStorage.getItem("app_parking_project") || ""; } catch { return ""; } })(),
};

// ---------- helpers ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "text") el.textContent = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}
// null·undefined·false 는 그리지 않는다(replaceChildren 은 null 을 "null" 글자로 만든다).
function fill(el, ...children) {
  el.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}
async function api(url, options) {
  const response = await fetch(url, { cache: "no-store", ...options, headers: { "Content-Type": "application/json", ...(options?.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error?.message || `HTTP ${response.status}`), { detail: data.error });
  return data;
}
const wsq = () => `workspace=${encodeURIComponent(S.workspace)}`;
const post = (path, body = {}) => api(path, { method: "POST", body: JSON.stringify({ workspace: S.workspace, ...body }) });
function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}초`;
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`;
}
function ago(iso) {
  if (!iso) return "기록 없음";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 90) return "방금 전";
  const m = s / 60; if (m < 90) return `${Math.round(m)}분 전`;
  const hr = m / 60; if (hr < 36) return `${Math.round(hr)}시간 전`;
  return `${Math.round(hr / 24)}일 전`;
}
function clock(iso) {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return "";
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}
function toast(message, detail = "") {
  const box = $("toast");
  fill(box, h("strong", { text: message }), detail ? h("pre", { text: detail }) : null,
    h("div", { class: "row" }, h("button", { class: "btn ghost", type: "button", onclick: () => { box.hidden = true; } }, "닫기"),
      detail ? h("button", { class: "btn ghost", type: "button", onclick: () => navigator.clipboard.writeText(`${message}\n${detail}`) }, "오류 복사") : null));
  box.hidden = false;
}
function friendly(error) {
  const message = String(error?.message || error);
  if (/relay.*not connected|릴레이/i.test(message)) return ["ChatGPT에 연결되어 있지 않습니다.", "chatgpt.com 탭에서 북마클릿(ChatGPT → 유지관리)을 실행한 뒤 다시 시도하세요."];
  if (/이미 다른 작업이 진행 중/.test(message)) return ["이미 진행 중인 작업이 있습니다.", "끝날 때까지 기다리거나 중단 버튼을 누르세요."];
  return [message, error?.detail ? JSON.stringify(error.detail) : ""];
}
const fail = (error) => { const [m, d] = friendly(error); toast(m, d); };

// ---------- session polling ----------
async function refreshSession() {
  try { S.session = await api(`/maintenance/session?${wsq()}`); }
  catch (error) { S.session = null; fail(error); }
  render();
}
let pollTimer = null;
function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = S.session?.job && !S.session.job.done;
  pollTimer = setTimeout(async () => { await refreshSession(); schedulePoll(); }, busy ? 1500 : 5000);
}

// ---------- rendering ----------
function currentStep() { return S.view === "parking" ? "parking" : (S.forceStep || S.session?.step || "scan"); }

function render() {
  const s = S.session;
  const relay = s?.relay || { level: "bad", label: "서버 응답 없음", hint: "앱 서버가 실행 중인지 확인하세요." };
  $("relay-pill").className = `pill ${relay.level}`;
  $("relay-label").textContent = relay.label;
  const hint = $("relay-hint");
  hint.hidden = !relay.hint; hint.textContent = relay.hint || "";
  renderFailure();
  renderNow();
  renderSteps();
  const step = currentStep();
  const key = `${step}:${s?.run?.id || ""}:${s?.run?.hasProposal}:${s?.job?.id || ""}:${s?.report?.finishedAt || ""}`;
  if (key !== S.panelKey) { S.panelKey = key; S.live = []; buildPanel(step); }
  for (const update of S.live) update();
  renderRecent();
  const fast = S.session?.fastScan;
  $("fast-note").textContent = !fast ? "" : fast.verified ? `빠른 스캔 검증 통과(${ago(fast.checkedAt)}). 기준선이 30일 이내면 증분으로 확인합니다.`
    : fast.reason ? `빠른 스캔을 쓸 수 없습니다: ${fast.message || "결과 불일치"}` : "빠른 스캔은 아직 검증 전입니다. 검증하면 새 대화 확인이 몇 초로 줄어듭니다.";
}

// 가장 최근 작업이 실패했고 그 뒤에 성공이 없으면 원인과 조치를 화면 맨 위에 보인다.
function renderFailure() {
  const last = S.session?.recentJobs?.[0]; const box = $("failure");
  const show = last && last.done && !last.ok && !S.dismissed.has(last.id) && !(S.session.job && !S.session.job.done);
  if (!show) { box.hidden = true; return; }
  const explain = last.error?.explain || { title: last.error?.message || "작업이 실패했습니다", action: "" };
  fill(box, h("strong", { text: explain.title }), h("p", { class: "small", text: explain.action }),
    h("div", { class: "row" },
      h("button", { class: "btn ghost", type: "button", onclick: () => navigator.clipboard.writeText(`${explain.title}\n${last.error?.message || ""}`) }, "오류 복사"),
      h("button", { class: "btn ghost", type: "button", onclick: () => { S.dismissed.add(last.id); render(); } }, "닫기")));
  box.hidden = false;
}

function renderNow() {
  const s = S.session; const step = currentStep(); const job = s?.job;
  let headline = "확인 중…"; let sub = ""; let action = null;
  const base = s?.baseline;
  if (job && !job.done) {
    headline = job.kind === "apply" ? "적용 중입니다" : "확인 중입니다";
    sub = job.progress ? `${job.progress.label}${job.progress.etaSeconds ? ` · 남은 시간 약 ${duration(job.progress.etaSeconds)}` : ""}` : "잠시만 기다려 주세요";
  } else if (step === "parking") {
    headline = "검토 대기"; sub = `ChatGPT의 「${s.parking?.project || "?"}」 프로젝트에서 직접 확인한 뒤 남길 것과 지울 것을 정하세요.`;
    action = h("button", { class: "btn ghost", type: "button", onclick: () => { S.view = null; S.panelKey = ""; render(); } }, "돌아가기");
  } else if (step === "scan") {
    headline = base?.stale === false ? "지난 확인 이후 새 대화를 확인해 보세요" : "새 대화를 확인할 시간입니다";
    sub = base ? `기준선 ${base.counts?.conversations ?? "?"}개 대화 · ${base.counts?.projects ?? "?"}개 프로젝트 · ${ago(base.generatedAt)} 확인` : "기준선이 아직 없습니다";
    action = h("button", { class: "btn", type: "button", disabled: !s?.relay?.connected, onclick: startScan }, "새 대화 확인");
  } else if (step === "proposal") {
    headline = `후보 ${s.run?.candidates ?? "?"}건의 분류가 필요합니다`; sub = "대화창의 에이전트에게 분류를 맡기세요(2단계).";
  } else if (step === "review") {
    headline = "분류 제안을 검토하세요"; sub = "바뀌는 내용을 확인하고 적용을 누르면 됩니다.";
  } else if (step === "result") {
    headline = s.report?.headline || "정리가 끝났습니다"; sub = `${ago(s.report?.finishedAt)} 완료`;
    action = h("button", { class: "btn ghost", type: "button", onclick: () => { S.forceStep = "scan"; S.panelKey = ""; render(); } }, "새 정리 시작");
  }
  fill($("now"), h("div", {}, h("p", { class: "headline", text: headline }), h("p", { class: "sub", text: sub })), action);
}

function renderSteps() {
  $("steps").hidden = currentStep() === "parking";
  const order = STEPS.map(([id]) => id); const at = order.indexOf(currentStep());
  fill($("steps"), ...STEPS.map(([id, label], i) =>
    h("li", { class: i < at ? "done" : i === at ? "current" : "" }, h("b", { text: `${i + 1}` }), label)));
}

function progressBlock(kind) {
  const bar = h("i"); const barWrap = h("div", { class: "bar" }, bar);
  const label = h("p", { class: "small" }); const log = h("pre", { class: "log" });
  const cancel = h("button", { class: "btn ghost", type: "button", onclick: async () => {
    if (!confirm("진행 중인 작업을 중단합니다. 이미 끝난 부분은 유지되고, 같은 버튼으로 이어서 진행할 수 있습니다.")) return;
    try { await post("/maintenance/cancel", { jobId: S.session.job.id }); } catch (e) { fail(e); }
  } }, "중단");
  const box = h("div", {}, barWrap, label, h("div", { class: "row" }, cancel), log);
  S.live.push(() => {
    const job = S.session?.job;
    if (!job) { label.textContent = ""; return; }
    const p = job.progress;
    if (p?.total > 0) { barWrap.classList.remove("indeterminate"); bar.style.width = `${Math.min(100, Math.round(p.index / p.total * 100))}%`; }
    else barWrap.classList.add("indeterminate");
    label.textContent = [p ? `${p.label}${p.total ? ` (${p.index}/${p.total})` : ""}` : "준비 중", p?.etaSeconds ? `남은 시간 약 ${duration(p.etaSeconds)}` : "", `경과 ${duration(job.elapsedSeconds)}`].filter(Boolean).join(" · ");
    fill(log, ...job.events.slice(-10).map((e) => h("div", { class: e.stage === "rate-limit" ? "rl" : e.stage === "error" ? "er" : "" }, `${clock(e.at)}  ${e.message}`)));
    log.scrollTop = log.scrollHeight;
  });
  return box;
}

function buildPanel(step) {
  const panel = $("panel"); fill(panel);
  const s = S.session;
  if (!s) { panel.append(h("p", { class: "muted", text: "앱 서버에 연결하는 중입니다…" })); return; }
  if (s.job && !s.job.done) {
    fill(panel, h("h2", { text: s.job.kind === "apply" ? "적용 중" : "확인 중" }),
      s.job.kind === "apply" ? applyStages() : null, progressBlock(s.job.kind));
    return;
  }
  if (step === "scan") panel.append(scanPanel());
  else if (step === "proposal") panel.append(proposalPanel());
  else if (step === "review") { panel.append(h("p", { class: "muted", text: "검토 내용을 불러오는 중…" })); loadReview(); }
  else if (step === "result") { panel.append(h("p", { class: "muted", text: "결과를 불러오는 중…" })); loadResult(); }
  else if (step === "parking") { panel.append(h("p", { class: "muted", text: "검토 대기 목록을 불러오는 중…" })); loadParking(); }
  else if (step === "apply") panel.append(applyReadyPanel());
  else panel.append(scanPanel());
}

const APPLY_STAGES = [["apply", "제목 변경·삭제"], ["checkpoint", "적용 결과 검증"], ["routing", "프로젝트 배치"], ["verify", "배치 검증"], ["report", "결과 정리"]];
function applyStages() {
  const list = h("ol", { class: "steps" });
  S.live.push(() => {
    const events = S.session?.job?.events || [];
    const stages = events.map((e) => e.stage);
    const idx = Math.max(-1, ...APPLY_STAGES.map(([id], i) => stages.lastIndexOf(id) >= 0 ? i : -1));
    fill(list, ...APPLY_STAGES.map(([, label], i) => h("li", { class: i < idx ? "done" : i === idx ? "current" : "" }, label)));
  });
  return list;
}

// ---------- step 1: scan ----------
function scanPanel() {
  const s = S.session; const base = s.baseline;
  return h("div", {},
    h("h2", { text: "1. 새 대화 확인" }),
    h("p", { class: "muted", text: "지난 확인 이후 새로 생기거나 바뀐 대화를 찾습니다. ChatGPT는 바꾸지 않습니다." }),
    s.run?.phase === "complete" && s.run.candidates === 0 && !s.run.hasReport ? h("p", { class: "chip good", text: `새 대화가 없습니다 · ${ago(s.run.updatedAt)} 확인` }) : null,
    base ? h("div", { class: "chips" }, h("span", { class: "chip", text: `대화 ${base.counts?.conversations ?? "?"}개` }),
      h("span", { class: "chip", text: `프로젝트 ${base.counts?.projects ?? "?"}개` }),
      h("span", { class: `chip ${base.stale ? "warn" : ""}`, text: `${ago(base.generatedAt)} 확인` }),
      base.verification === "assume-quiet" ? h("span", { class: "chip warn", text: "빠른 검증으로 확정된 기준선" }) : null,
      h("span", { class: `chip ${s.fastScan?.nextScanIncremental ? "good" : ""}`, text: s.fastScan?.nextScanIncremental ? "증분 스캔(빠름)" : "전체 스캔" })) : null,
    h("div", { class: "row" }, h("button", { class: "btn", type: "button", disabled: !s.relay?.connected, onclick: startScan }, "새 대화 확인"),
      !s.relay?.connected ? h("span", { class: "muted small", text: s.relay?.hint || "" }) : null),
    s.parking?.count ? h("div", { class: "copybox", style: "margin-top:14px" },
      h("strong", { text: `검토 대기 ${s.parking.count}건` }), " — 삭제 후보를 ChatGPT의 ",
      h("b", { text: `「${s.parking.project}」` }), " 프로젝트에 모아 두었습니다. 직접 확인한 뒤 확정하세요. ",
      h("button", { class: "btn ghost", type: "button", onclick: () => { S.view = "parking"; S.panelKey = ""; render(); } }, "검토 대기 열기")) : null);
}

// 이미 검토가 끝난 결정(후속 실행 등)을 적용한다. 서버가 도중에 멈춰도 같은 버튼으로 이어진다.
function applyReadyPanel() {
  return h("div", {}, h("h2", { text: "적용 대기" }),
    h("p", { class: "muted", text: "검토가 끝난 결정이 있습니다. 적용을 시작하면 끝날 때까지 자동으로 이어집니다." }),
    h("div", { class: "row" }, h("button", { class: "btn", type: "button", disabled: !S.session?.relay?.connected, onclick: async () => {
      try { await post("/maintenance/apply", { confirmDeletes: true, quiet: $("quiet").checked }); await refreshSession(); } catch (e) { fail(e); }
    } }, "적용 시작")));
}

// ---------- 검토 대기 ----------
async function loadParking() {
  try {
    const data = await api(`/maintenance/parking?${wsq()}`); S.parking = data;
    const choices = new Map(data.items.map((i) => [i.conversationId, { decision: "delete", project: i.intendedTarget || i.fromProject || "", title: "" }]));
    const names = (S.catalog?.projects || []).map((p) => p.projectName);
    if (!S.catalog) { try { S.catalog = await api(`/maintenance/catalog?${wsq()}`); } catch {} }
    const projectNames2 = [...new Set([...(S.catalog?.projects || []).map((p) => p.projectName), ...names])].filter((n) => n !== data.project).sort();
    const draw = () => {
      const deletes = [...choices.values()].filter((c) => c.decision === "delete").length;
      fill($("panel"), h("h2", { text: `검토 대기 ${data.items.length}건` }),
        h("p", { class: "muted", text: `ChatGPT의 「${data.project}」 프로젝트에서 대화를 직접 확인하세요. 여기서 정한 대로 삭제하거나 원래 자리로 옮깁니다. (직접 지운 대화는 다음 전체 스캔에서 반영됩니다)` }),
        !data.items.length ? h("p", { class: "chip good", text: "검토 대기 중인 대화가 없습니다" }) : null,
        h("div", { class: "row" }, h("button", { class: "btn ghost", type: "button", onclick: () => { for (const c of choices.values()) c.decision = "delete"; draw(); } }, "전부 삭제로"),
          h("button", { class: "btn ghost", type: "button", onclick: () => { for (const c of choices.values()) c.decision = "keep"; draw(); } }, "전부 남기기로")),
        ...data.items.map((i) => {
          const c = choices.get(i.conversationId);
          const needsTitle = !isNormalizedTitle(i.title) && c.decision === "keep";
          const projSel = h("select", { onchange: (e) => { c.project = e.target.value; } }, h("option", { value: "", text: "프로젝트 없음" }), ...projectNames2.map((n) => h("option", { value: n, text: n })));
          projSel.value = c.project;
          const titleInput = needsTitle ? h("input", { class: `title-input${isNormalizedTitle(c.title) ? "" : " invalid"}`, type: "text", value: c.title || "", placeholder: "새 제목 (주제 — 작업/결과)",
            onchange: (e) => { c.title = e.target.value.trim(); draw(); } }) : null;
          return h("div", { class: "item" }, h("div", { class: "t", text: i.title }),
            h("div", { class: "ctl" }, h("select", { onchange: (e) => { c.decision = e.target.value; draw(); } },
              h("option", { value: "delete", text: "삭제", selected: c.decision === "delete" ? "" : null }), h("option", { value: "keep", text: "남기기", selected: c.decision === "keep" ? "" : null })),
              c.decision === "keep" ? projSel : null),
            h("div", { class: "m", text: `${i.fromProject || "프로젝트 없음"}에서 보관 · ${i.reason || ""}${i.inBaseline ? "" : " · 기준선에 없음(이미 삭제됨?)"}` }), titleInput);
        }),
        h("div", { class: "applybar" }, h("div", {}, h("strong", { text: `삭제 ${deletes}건 · 남기기 ${data.items.length - deletes}건` })),
          h("button", { class: "btn", type: "button", disabled: !data.items.length || !S.session?.relay?.connected, onclick: () => applyParking(data, choices, deletes) }, "확정하고 적용")));
    };
    draw();
  } catch (e) { fail(e); }
}
async function applyParking(data, choices, deletes) {
  const bad = data.items.filter((i) => { const c = choices.get(i.conversationId); return c.decision === "keep" && !isNormalizedTitle(i.title) && !isNormalizedTitle(c.title); });
  if (bad.length) { toast(`남길 대화 ${bad.length}건의 제목을 표준 형식(주제 — 작업/결과)으로 적어 주세요.`); return; }
  if (deletes && !confirm(`삭제 ${deletes}건은 되돌릴 수 없습니다. 확정할까요?`)) return;
  try {
    await post("/maintenance/parking/prepare", { decisions: data.items.map((i) => { const c = choices.get(i.conversationId);
      return { conversationId: i.conversationId, decision: c.decision, projectName: c.project, newTitle: c.decision === "keep" && !isNormalizedTitle(i.title) ? c.title : undefined }; }) });
    await post("/maintenance/apply", { confirmDeletes: deletes > 0, quiet: $("quiet").checked });
    S.view = null; S.forceStep = null; S.panelKey = ""; await refreshSession();
  } catch (e) { fail(e); }
}
async function startScan() {
  try { S.forceStep = null; await post("/maintenance/scan"); await refreshSession(); } catch (e) { fail(e); }
}
async function startProbe() {
  if (!confirm("빠른 목록 방식이 전체 방식과 같은 결과인지 확인합니다(읽기 전용, 수 분). 통과하면 다음 확인부터 증분 스캔을 씁니다. 시작할까요?")) return;
  try { S.forceStep = null; await post("/maintenance/probe"); await refreshSession(); } catch (e) { fail(e); }
}
async function startFullScan() {
  try { S.forceStep = null; await post("/maintenance/scan", { full: true }); await refreshSession(); } catch (e) { fail(e); }
}
async function startCollect() {
  if (!confirm("모든 대화 본문을 받습니다(수백 건, 수 분~수 시간). ChatGPT는 바뀌지 않으며 끊기면 이어받습니다. 시작할까요?")) return;
  try { S.forceStep = null; await post("/maintenance/collect"); await refreshSession(); } catch (e) { fail(e); }
}

// ---------- step 2: proposal ----------
function proposalPanel() {
  const run = S.session.run;
  const prompt = "이 저장소에서 `npm run brief`를 실행하고, 안내대로 분류 제안(proposal.json)을 만들어 검증해줘.";
  const paste = h("textarea", { rows: "6", style: "width:100%", placeholder: "분류 결과 JSON 붙여넣기" });
  return h("div", {},
    h("h2", { text: "2. 분류 제안 받기" }),
    h("p", { class: "muted", text: `새로 확인된 후보 ${run?.candidates ?? "?"}건을 대화창의 에이전트에게 분류시킵니다. 제안 파일이 만들어지면 이 화면이 자동으로 다음 단계로 넘어갑니다.` }),
    h("p", { class: "small", text: "에이전트에게 이렇게 말하세요:" }),
    h("div", { class: "copybox", text: prompt }),
    h("div", { class: "row" }, h("button", { class: "btn", type: "button", onclick: async (e) => { await navigator.clipboard.writeText(prompt); e.target.textContent = "복사됨"; } }, "문장 복사")),
    h("details", {}, h("summary", { text: "에이전트 없이 결과 JSON을 붙여넣기" }),
      h("div", { class: "body" }, paste, h("div", { class: "row" }, h("button", { class: "btn ghost", type: "button", onclick: async () => {
        try { await post("/maintenance/proposal", { proposalJson: paste.value }); await refreshSession(); } catch (e) { fail(e); }
      } }, "검증하고 불러오기")))));
}

// ---------- step 3: review ----------
async function loadReview() {
  try {
    const [proposal, catalog] = await Promise.all([api(`/maintenance/proposal?${wsq()}`), api(`/maintenance/catalog?${wsq()}`)]);
    S.proposal = proposal; S.catalog = catalog;
    if (!proposal.ready) { fill($("panel"), h("p", { text: "분류 제안이 아직 없습니다." })); return; }
    S.overrides = S.overrides.size ? S.overrides : new Map();
    drawReview();
  } catch (e) { fail(e); }
}

function effectiveRows() {
  const rows = rowsFromProposal(S.proposal, { conversations: [] });
  return rows.map((row) => {
    const o = S.overrides.get(row.conversationId); if (!o) return row;
    const next = { ...row, undecided: false };
    if (o.decision) next.decision = o.decision;
    if (o.title !== undefined) next.newTitle = o.title;
    if (o.project !== undefined) next.project = o.project || null;
    if (o.decision === "keep" && o.project === undefined && !row.project) next.project = row.currentProject;
    return next;
  }).map((row) => {
    if (!S.parkingProject || row.decision !== "delete") return row;
    // 삭제 후보는 곧바로 지우지 않고 보관 프로젝트로 옮긴다. 표준 제목이 아니면 보관용 제목을 붙인다.
    return { ...row, decision: "keep", project: S.parkingProject, parked: true, newTitle: null };
  });
}
const patch = (id, changes) => { S.overrides.set(id, { ...(S.overrides.get(id) || {}), ...changes }); drawReview(); };
function projectNames() {
  const names = new Set((S.catalog?.projects || []).map((p) => p.projectName));
  for (const item of S.proposal?.items || []) if (item.suggestedProjectName) names.add(item.suggestedProjectName);
  return [...names].sort((a, b) => a.localeCompare(b));
}
function projectSelect(value, onchange) {
  const select = h("select", { onchange: (e) => onchange(e.target.value) }, h("option", { value: "", text: "프로젝트 없음" }),
    ...projectNames().map((n) => h("option", { value: n, text: n })));
  select.value = value || ""; return select;
}

function drawReview() {
  const rows = effectiveRows();
  const summary = buildReviewSummary({ catalog: S.catalog, rows });
  const ex = summary.exceptions; const c = summary.changes; const t = summary.totals;
  const invalid = rows.filter((r) => r.decision === "keep" && !r.parked && !isNormalizedTitle(r.newTitle || r.title));
  const blockers = [];
  if (t.undecided) blockers.push(`미결정 ${t.undecided}건을 정해 주세요`);
  if (invalid.length) blockers.push(`제목 형식이 맞지 않는 대화 ${invalid.length}건`);
  const moveList = ex.moves.slice(0, 200);
  const panel = $("panel");
  fill(panel, 
    h("h2", { text: "3. 바뀌는 내용 검토" }),
    h("p", { class: "headline", style: "font-size:20px;font-weight:650;margin:0 0 4px", text: summary.headline }),
    h("div", { class: "chips" }, h("span", { class: "chip", text: `후보 ${t.candidates}건` }), h("span", { class: "chip good", text: `보존 ${t.keep}` }),
      h("span", { class: t.delete ? "chip warn" : "chip", text: `삭제 ${t.delete}` }), t.undecided ? h("span", { class: "chip bad", text: `미결정 ${t.undecided}` }) : null,
      c.remove ? h("span", { class: "chip warn", text: `직접 빼야 할 대화 ${c.remove}` }) : null),
    projectTable(summary),
    parkingControl(t.delete + t.parked),
    section("임시 보관(삭제 후보)", ex.parked.length, ex.parked.map((d) => item(d.title, `${d.project || "프로젝트 없음"} · ${d.why || ""}`, [])), false),
    section("삭제 후보", ex.deletes.length, ex.deletes.map((d) => item(d.title, `${d.project || "프로젝트 없음"} · ${d.why || ""}`, [
      h("button", { class: "btn ghost", type: "button", onclick: () => patch(d.conversationId, { decision: "keep", project: d.project || "" }) }, "보존으로 바꾸기")])), ex.deletes.length > 0 && ex.deletes.length <= 60),
    section("결정이 필요한 항목(미결정)", ex.undecided.length, ex.undecided.map((d) => item(d.title, d.why || "판단 근거 없음", [
      h("button", { class: "btn ghost", type: "button", onclick: () => patch(d.conversationId, { decision: "keep", project: d.project || "" }) }, "보존"),
      h("button", { class: "btn ghost", type: "button", onclick: () => patch(d.conversationId, { decision: "delete" }) }, "삭제")])), true),
    section("프로젝트 이동", ex.moves.length, moveList.map((m) => item(m.title, `${m.from || "프로젝트 없음"} → ${m.to}`, [
      projectSelect(m.to, (v) => patch(m.conversationId, { project: v }))])), false, ex.moves.length > 200 ? `처음 200건만 표시(전체 ${ex.moves.length}건)` : ""),
    section("제목 변경", ex.renames.length, ex.renames.slice(0, 200).map((r) => titleItem(r)), false),
    section("확신이 낮은 항목", ex.lowConfidence.length, ex.lowConfidence.map((d) => item(d.title, d.why || "", [])), false),
    c.newProjects.length ? section("새로 만들 프로젝트", c.newProjects.length, c.newProjects.map((n) => item(n, "적용할 때 자동으로 만듭니다", [])), true) : null,
    ex.manualRemoves.length ? section("직접 빼야 하는 대화", ex.manualRemoves.length, ex.manualRemoves.map((m) => item(m.title, `현재 프로젝트: ${m.project} — 앱은 프로젝트에서 뺄 수 없어 결과 화면에 안내합니다`, [])), false) : null,
    h("div", { class: "applybar" }, h("div", {}, h("strong", { text: summary.headline }), blockers.length ? h("div", { class: "small", style: "color:var(--danger)", text: blockers.join(" · ") }) : null),
      h("button", { class: "btn", type: "button", disabled: blockers.length > 0 || !S.session.relay?.connected, onclick: () => confirmApply(summary) }, "적용")));
}
function parkingControl(candidates) {
  if (!candidates) return null;
  const check = h("input", { type: "checkbox", checked: S.parkingProject ? true : null });
  const name = h("input", { type: "text", value: S.parkingProject || "주식", style: "width:140px" });
  const commit = () => {
    S.parkingProject = check.checked ? name.value.trim() : "";
    try { localStorage.setItem("app_parking_project", S.parkingProject); } catch {}
    drawReview();
  };
  check.addEventListener("change", commit); name.addEventListener("change", () => { if (check.checked) commit(); });
  return h("label", { class: "check" }, check, "삭제 후보를 곧바로 지우지 않고 먼저", name, "프로젝트에 임시 보관합니다(ChatGPT에서 직접 확인한 뒤 삭제 확정)");
}
function section(title, count, items, open, note = "") {
  if (!count) return null;
  return h("details", { open: open || null }, h("summary", { text: `${title} (${count})` }), h("div", { class: "body" }, note ? h("p", { class: "muted small", text: note }) : null, items));
}
function item(title, meta, controls) {
  return h("div", { class: "item" }, h("div", { class: "t", text: title }), h("div", { class: "ctl" }, controls), h("div", { class: "m", text: meta }));
}
function titleItem(r) {
  const input = h("input", { class: "title-input", type: "text", value: r.to });
  const apply = () => { const v = input.value.trim(); input.classList.toggle("invalid", !isNormalizedTitle(v)); patch(r.conversationId, { title: v }); };
  input.addEventListener("change", apply);
  return h("div", { class: "item" }, h("div", { class: "t", text: r.from }), h("div", { class: "m", text: "→ 새 제목 (주제 — 작업/결과)" }), input);
}
function projectTable(summary) {
  const rows = summary.projects.filter((p) => p.delta !== 0 || p.isNew);
  if (!rows.length) return null;
  return h("details", { open: true }, h("summary", { text: `프로젝트별 변화 (${rows.length})` }), h("div", { class: "body" },
    h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "프로젝트" }), h("th", { class: "num", text: "이전" }), h("th", { class: "num", text: "이후" }), h("th", { class: "num", text: "변화" }))),
      h("tbody", {}, rows.map((p) => h("tr", {}, h("td", { text: `${p.name}${p.isNew ? " (신규)" : ""}` }), h("td", { class: "num", text: p.before }), h("td", { class: "num", text: p.after }),
        h("td", { class: `num ${p.delta > 0 ? "up" : "down"}`, text: `${p.delta > 0 ? "+" : ""}${p.delta}` })))))));
}

function confirmApply(summary) {
  const dlg = $("confirm"); const form = $("confirm-form"); const deletes = summary.totals.delete;
  const ack = h("input", { type: "checkbox" }); const go = h("button", { class: "btn", value: "go", disabled: deletes > 0 }, "적용 시작");
  ack.addEventListener("change", () => { go.disabled = !ack.checked; });
  fill(form, h("h2", { text: "이 내용으로 적용할까요?" }), h("p", { text: summary.headline }),
    deletes ? h("label", { class: "check" }, ack, `삭제 ${deletes}건은 되돌릴 수 없음을 확인했습니다`) : null,
    summary.totals.parked ? h("p", { class: "small", text: `임시 보관 ${summary.totals.parked}건은 지우지 않고 「${S.parkingProject}」로 옮깁니다.` }) : null,
    h("p", { class: "muted small", text: "적용은 끝날 때까지 자동으로 이어집니다(429·일시적 오류는 기다렸다가 재개). 이 화면을 닫아도 서버가 계속 진행합니다." }),
    h("div", { class: "row" }, go, h("button", { class: "btn ghost", value: "cancel" }, "취소")));
  dlg.onclose = async () => {
    if (dlg.returnValue !== "go") return;
    try {
      const decisions = effectiveRows().map((r) => r.decision === "delete"
        ? { conversationId: r.conversationId, decision: "delete" }
        : { conversationId: r.conversationId, decision: "keep", newTitle: (r.newTitle || r.title).trim(), projectName: (r.project || "").trim(),
          ...(r.parked ? { parked: true } : {}) });
      const parkedRows = effectiveRows().filter((r) => r.parked);
      await post("/maintenance/decisions", { decisions, parking: parkedRows.length ? {
        project: S.parkingProject, entries: parkedRows.map((r) => ({ conversationId: r.conversationId, reason: r.why, intendedTarget: null })) } : undefined });
      await post("/maintenance/apply", { confirmDeletes: deletes > 0, quiet: $("quiet").checked });
      S.overrides = new Map(); S.forceStep = null;
      await refreshSession();
    } catch (e) { fail(e); }
  };
  dlg.showModal();
}

// ---------- step 5: result ----------
async function loadResult() {
  try {
    const data = await api(`/maintenance/report?${wsq()}`);
    if (!data.ready) { fill($("panel"), h("p", { class: "muted", text: "결과 보고서가 없습니다." })); return; }
    const r = data.report; const todo = r.todo;
    const copy = (text) => h("button", { class: "btn ghost", type: "button", onclick: async (e) => { await navigator.clipboard.writeText(text); e.target.textContent = "복사됨"; } }, "목록 복사");
    fill($("panel"), 
      h("h2", { text: "5. 정리 결과" }), h("p", { class: "headline", style: "font-size:20px;font-weight:650;margin:0", text: r.headline }),
      h("p", { class: "muted small", text: r.note }),
      r.mismatches.length ? h("p", { class: "chip bad", text: `예상과 다른 프로젝트: ${r.mismatches.join(", ")}` }) : h("p", { class: "chip good", text: "모든 프로젝트가 예상과 일치합니다" }),
      h("h3", { text: "직접 하실 일" }),
      !todo.deleteEmptyProjects.length && !todo.removeFromProject.length ? h("p", { class: "muted", text: "없습니다." }) : null,
      todo.deleteEmptyProjects.length ? h("div", {}, h("p", { text: "비어 있는 프로젝트 — 필요 없으면 ChatGPT에서 삭제하세요:" }),
        h("ul", { class: "todo" }, todo.deleteEmptyProjects.map((n) => h("li", { text: n }))), copy(todo.deleteEmptyProjects.join("\n"))) : null,
      todo.removeFromProject.length ? h("div", {}, h("p", { text: "프로젝트에서 직접 빼야 하는 대화(앱은 뺄 수 없음):" }),
        h("ul", { class: "todo" }, todo.removeFromProject.map((m) => h("li", { text: `${m.title} — 현재 ${m.project}` })))) : null,
      h("h3", { text: "프로젝트별 변화" }),
      h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "프로젝트" }), h("th", { class: "num", text: "이전" }), h("th", { class: "num", text: "이후" }), h("th", { class: "num", text: "변화" }))),
        h("tbody", {}, r.projects.filter((p) => p.delta !== 0 || p.isNew).map((p) => h("tr", {}, h("td", { text: `${p.name}${p.isNew ? " (신규)" : ""}` }), h("td", { class: "num", text: p.before }), h("td", { class: "num", text: p.actualAfter }),
          h("td", { class: `num ${p.delta > 0 ? "up" : "down"}`, text: `${p.delta > 0 ? "+" : ""}${p.delta}` }))))));
  } catch (e) { fail(e); }
}

// ---------- recent jobs ----------
function renderRecent() {
  const jobs = S.session?.recentJobs || [];
  fill($("recent"), ...(jobs.length ? jobs.map((j) => h("div", { class: "job" },
    h("strong", { text: `${j.kind === "apply" ? "적용" : "확인"} · ${ago(j.startedAt)} · ${!j.done ? "진행 중" : j.ok ? "성공" : j.interrupted ? "중단됨" : "실패"}` }),
    j.error ? h("div", { class: "muted", text: j.error.message }) : h("div", { class: "muted", text: j.events.at(-1)?.message || "" }))) : [h("p", { class: "muted", text: "기록이 없습니다." })]));
}

// ---------- boot ----------
async function boot() {
  $("theme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next; try { localStorage.setItem("maintenance_theme", next); } catch {}
  });
  $("relay-pill").addEventListener("click", () => { const hint = S.session?.relay?.hint; if (hint) toast(S.session.relay.label, hint); });
  $("collect").addEventListener("click", startCollect);
  $("probe").addEventListener("click", startProbe);
  $("full-scan").addEventListener("click", startFullScan);
  $("workspace").addEventListener("change", () => { S.workspace = $("workspace").value.trim(); try { localStorage.setItem("app_workspace", S.workspace); } catch {} refreshSession(); });
  const config = await api("/config").catch(() => ({}));
  S.workspace = (() => { try { return localStorage.getItem("app_workspace"); } catch { return null; } })() || config.workspace || "";
  $("workspace").value = S.workspace;
  startRelay({ api, release: meta("app-release"), protocolVersion: Number(meta("relay-protocol")), onState: (state) => { S.relayLocal = state; } });
  await refreshSession();
  schedulePoll();
}
boot();
