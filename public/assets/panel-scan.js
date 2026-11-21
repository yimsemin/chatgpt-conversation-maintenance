// 확인 패널(수집 범위 선택)과 적용 대기 패널.
import { t } from "/assets/language.js";
import { S, hooks } from "/assets/state.js";
import { ask, h, when } from "/assets/dom.js";
import { fail, post, toast } from "/assets/net.js";
import { projectIdFromLink } from "/assets/shared/project-link.js";
import { refreshSession } from "/assets/session-client.js";

// ---------- step 1: scan ----------
const SCOPE_KINDS = [["unassigned", t("scan.conversations.without.a.project")], ["project", t("scan.conversations.in.selected.projects")], ["recent", t("scan.recently.updated.conversations")], ["untidy", t("scan.unorganized.conversations.until.standard.titles")],
  ["all", t("scan.all.conversations.full.cleanup.can.take.a")]];

// 프로젝트 없는 대화의 기간 선택지(일). 0 은 기간 제한 없음.
const UNASSIGNED_WINDOWS = [[14, t("scan.last.14.days")], [30, t("scan.last.30.days")], [0, t("scan.all.time")]];

// 받지 못하는 대화를 4회 실패 시 건너뛸지(기본 켬). 끄면 전부 받을 때까지 멈추고 재시도한다.
// 수집 옵션 한 줄: 체크 상자(브라우저에 기억) + 짧은 설명.
function option(key, on, label, note) {
  return h("label", { class: "check" }, h("input", { type: "checkbox", checked: on ? true : null, onchange: (e) => { try { localStorage.setItem(key, e.target.checked ? "1" : "0"); } catch {} } }),
    h("span", {}, label, h("span", { class: "muted", text: ` — ${note}` })));
}

function skipFailedOn() { try { return localStorage.getItem("app_skip_failed") !== "0"; } catch { return true; } }

function skipStandardOn() { try { return localStorage.getItem("app_skip_standard") === "1"; } catch { return false; } }

function saveScope() { try { localStorage.setItem("app_scan_scope", JSON.stringify(S.scope)); } catch {} }

export function loadScope() {
  try {
    const saved = JSON.parse(localStorage.getItem("app_scan_scope") || "null");
    if (saved?.kind) S.scope = { ...S.scope, ...saved, projectNames: Array.isArray(saved.projectNames) ? saved.projectNames : [] };
  } catch {}
  if (!SCOPE_KINDS.some(([value]) => value === S.scope.kind)) S.scope.kind = "unassigned";
  if (!UNASSIGNED_WINDOWS.some(([value]) => value === S.scope.window)) S.scope.window = 14;
}

const SCOPE_HINTS = {
  unassigned: t("scan.organize.conversations.that.are.outside.projects.a"),
  project: t("scan.collect.conversations.only.from.the.chosen.projects"),
  recent: t("scan.collect.recently.updated.conversations.for.a.complete"),
  untidy: t("scan.read.newest.updates.first.and.stop.after"),
  all: t("scan.collect.and.reclassify.all.conversations.including.archived"),
};

// 프로젝트가 마지막으로 쓰인 때를 사람이 읽는 말로(알 때만).
function since(iso) {
  const ms = Date.parse(iso || ""); if (!Number.isFinite(ms)) return "";
  const days = Math.floor((Date.now() - ms) / 86400000);
  return days <= 0 ? t("scan.today") : t("scan.days.ago", { days: days });
}

// 수집 범위를 고른다. 후보는 고른 범위의 대화 전부이며 지난 확인과 비교하지 않는다.
function scopePicker() {
  const s = S.session;
  const kind = h("select", { onchange: (e) => { S.scope.kind = e.target.value; saveScope(); S.panelKey = ""; hooks.render(); } },
    ...SCOPE_KINDS.map(([value, label]) => h("option", { value, text: label })));
  kind.value = S.scope.kind;
  const days = h("input", { type: "number", min: "1", max: "3650", value: String(S.scope.days || 7), size: "4",
    onchange: (e) => { S.scope.days = Math.max(1, Math.min(3650, Math.floor(Number(e.target.value)) || 7)); saveScope(); } });
  // 프로젝트 없는 대화는 기간을 좁힐 수 있다(기본 14일). 기간이 짧을수록 대화 목록을 덜 읽는다.
  const period = h("select", { onchange: (e) => { S.scope.window = Number(e.target.value); saveScope(); } },
    ...UNASSIGNED_WINDOWS.map(([value, label]) => h("option", { value: String(value), text: label })));
  period.value = String(S.scope.window);
  // 한 줄: 범위 선택 + (프로젝트 없는 대화면 기간, 최근 N일이면 일수 입력)
  const line = h("div", { class: "row" }, h("label", { class: "field inline" }, t("scan.collection.scope"), kind),
    S.scope.kind === "unassigned" ? h("label", { class: "field inline" }, t("scan.time.range"), period) : null,
    S.scope.kind === "recent" ? h("label", { class: "field inline" }, t("scan.last"), days, t("scan.days")) : null);
  return h("div", {}, line, S.scope.kind === "project" ? projectChooser() : null, h("p", { class: "muted small", text: SCOPE_HINTS[S.scope.kind] }));
}

// 프로젝트를 여러 개 고른다. 최근에 쓴 프로젝트가 앞에 온다(수정 시각을 알 수 있으면 그 순서, 아니면 ChatGPT 목록 순서).
function projectChooser() {
  const s = S.session;
  const projects = s.knownProjects?.projects || [];
  const chosen = new Set(S.scope.projectNames);
  const count = h("span", { class: "muted small", text: t("scan.selected", { count: chosen.size }) });
  const items = projects.map((project) => {
    const box = h("input", { type: "checkbox", checked: chosen.has(project.name) ? true : null, onchange: (e) => {
      if (e.target.checked) chosen.add(project.name); else chosen.delete(project.name);
      S.scope.projectNames = projects.map((p) => p.name).filter((name) => chosen.has(name));
      count.textContent = t("scan.selected", { count: chosen.size }); saveScope();
    } });
    return h("label", { class: "check project-item" }, box, project.name, project.updatedAt ? h("span", { class: "muted small", text: ` · ${since(project.updatedAt)}` }) : null);
  });
  // 프로젝트 링크(ChatGPT에서 프로젝트를 열었을 때 주소창 주소)를 붙여 넣으면 그 프로젝트를 고른다.
  const link = h("input", { type: "text", size: "34", placeholder: t("scan.paste.a.project.link"), onchange: (e) => {
    const id = projectIdFromLink(e.target.value); e.target.value = "";
    const project = id ? projects.find((p) => p.id === id) : null;
    if (!id) { toast(t("scan.that.isn.t.a.project.link"), t("scan.paste.the.url.of.the.project.open")); return; }
    if (!project) { toast(t("scan.project.not.in.the.list"), t("scan.click.refresh.project.list.then.paste.the")); return; }
    if (!chosen.has(project.name)) { chosen.add(project.name); S.scope.projectNames = projects.map((p) => p.name).filter((name) => chosen.has(name)); saveScope(); }
    toast(t("scan.project.selected"), project.name); S.panelKey = ""; hooks.render();
  } });
  return h("div", {},
    h("div", { class: "row" }, count, link,
      h("button", { class: "btn ghost", type: "button", disabled: !s.relay?.connected, onclick: startProjectList }, projects.length ? t("scan.refresh.project.list") : t("scan.load.project.list"))),
    projects.length ? h("div", { class: "project-list" }, items) : h("p", { class: "muted small", text: t("scan.load.the.project.list.first.it.takes") }));
}

// 실행(run)에 기록된 수집 범위를 사람이 읽는 말로.
export function scopeLabel(scope) {
  if (!scope) return "";
  if (scope.kind === "project") return t("scan.projects", { projects: scope.projectNames.map((name) => t("common.quoted", { text: name })).join(", ") });
  if (scope.kind === "recent") return t("scan.last.days", { days: scope.days });
  if (scope.kind === "untidy") return t("scan.unorganized.conversations");
  if (scope.kind === "all") return t("scan.all.conversations");
  return scope.days ? t("scan.conversations.without.a.project.last.days", { days: scope.days }) : t("scan.conversations.without.a.project");
}

// 진행 중인 분류·검토가 있으면 새 수집을 시작할 때 버려진다는 것을 알린다.
function pendingRun() {
  const run = S.session?.run;
  return run && run.phase !== "complete" ? run : null;
}

function scanBody() {
  const { kind, projectNames, days, window } = S.scope;
  const skipFailed = skipFailedOn();
  const skipStandardTitles = skipStandardOn();
  if (kind === "project") return { scope: { kind, projectNames }, skipFailed, skipStandardTitles };
  if (kind === "recent") return { scope: { kind, days }, skipFailed, skipStandardTitles };
  if (kind === "unassigned") return { scope: window ? { kind, days: window } : { kind }, skipFailed, skipStandardTitles };
  return { scope: { kind }, skipFailed, skipStandardTitles };
}

// 받지 못해 건너뛴 대화 안내. 후보에서 빠졌으므로 나중에 같은 범위로 다시 확인하면 다시 시도한다.
export function skippedCallout(skipped) {
  return h("div", { class: "callout" }, h("strong", { text: t("scan.conversations.skipped", { count: skipped.length }) }),
    t("scan.chatgpt.did.not.return.these.after.four"),
    h("ul", {}, ...skipped.slice(0, 20).map((item) => h("li", { text: `${item.title}${item.status ? ` (HTTP ${item.status})` : ""}` })),
      skipped.length > 20 ? h("li", { text: t("scan.and.more", { count: skipped.length - 20 }) }) : null));
}

// 삭제후보 프로젝트에 옮겨 둔 대화 현황.
function trashCallout() {
  const trash = S.session.trash;
  if (!trash?.count) return null;
  return h("div", { class: "callout" },
    h("strong", { text: t("scan.deletion.candidates", { count: trash.count }) }), t("scan.chatgpt.project"), h("b", { text: t("common.quoted", { text: trash.project }) }),
    t("scan.review.the.candidates.to.delete.or.restore", { oldest: trash.oldestDays ? t("scan.oldestCandidate", { days: trash.oldestDays }) : "" }),
    h("button", { class: "btn ghost", type: "button", onclick: () => { S.view = "trash"; S.panelKey = ""; hooks.render(); } }, t("scan.review.deletion.candidates")));
}

export function scanPanel() {
  const s = S.session;
  const last = s.run?.phase === "complete" && s.run.candidates === 0 && !s.run.hasReport ? s.run : null;
  const pending = pendingRun();
  return h("div", {},
    pending ? h("div", { class: "callout" }, h("strong", { text: t("scan.a.cleanup.is.in.progress") }),
      t("scan.candidates.collecting.again.starts.a.new.cleanup", { scope: scopeLabel(pending.scope), count: pending.candidates ?? "?" }),
      h("button", { class: "btn ghost", type: "button", onclick: () => { S.forceStep = null; S.panelKey = ""; hooks.render(); } }, t("scan.return.to.that.cleanup"))) : null,
    s.partialScan ? h("div", { class: "callout" }, h("strong", { text: t("scan.a.collection.was.interrupted") }),
      t("scan.collected.of.collect.the.same.scope.again", { scope: scopeLabel(s.partialScan.scope), total: s.partialScan.total, downloaded: s.partialScan.downloaded }),
      h("button", { class: "btn ghost", type: "button", onclick: startPartialScan }, t("scan.classify.collected.conversations", { count: s.partialScan.downloaded }))) : null,
    scopePicker(),
    option("app_skip_failed", skipFailedOn(), t("scan.skip.conversations.after.four.failed.attempts"), t("scan.turn.this.off.to.keep.retrying.a")),
    option("app_skip_standard", skipStandardOn(), t("scan.skip.conversations.with.a.standard.title"), t("scan.also.skips.conversations.whose.titles.you.chose")),
    h("div", { class: "row" }, h("button", { class: "btn", type: "button", disabled: !s.relay?.connected, onclick: startScan }, t("scan.collect.this.scope"))),
    last ? h("p", { class: "chip good", text: t("scan.no.conversations.to.clean.up.in.this", { when: when(last.updatedAt) }) }) : null,
    last?.standardTitlesExcluded ? h("p", { class: "muted small", text: t("scan.skipped.conversations.with.standard.or.explicitly.preserved", { count: last.standardTitlesExcluded }) }) : null,
    last?.skipped?.length ? skippedCallout(last.skipped) : null,
    !s.relay?.connected ? h("p", { class: "muted small", text: t("scan.connect.to.chatgpt.to.collect.this.scope") }) : null,
    trashCallout());
}

// 이미 검토가 끝난 결정(후속 실행 등)을 적용한다. 서버가 도중에 멈춰도 같은 버튼으로 이어진다.
export function applyReadyPanel() {
  return h("div", {}, h("h2", { text: t("scan.ready.to.apply") }),
    h("p", { class: "muted", text: t("scan.reviewed.decisions.are.ready.once.you.start") }),
    h("div", { class: "row" }, h("button", { class: "btn", type: "button", disabled: !S.session?.relay?.connected, onclick: async () => {
      try { await post("/maintenance/apply", { confirmDeletes: true }); await refreshSession(); } catch (e) { fail(e); }
    } }, t("scan.start.applying.changes"))));
}

export async function startScan() {
  if (S.scope.kind === "project" && !S.scope.projectNames.length) { toast(t("scan.choose.projects"), t("scan.choose.at.least.one.project.to.collect")); return; }
  const pending = pendingRun();
  if (pending && !await ask({ title: t("scan.start.a.new.collection"), lines: [t("scan.replaceCollectionWarning", { scope: scopeLabel(pending.scope), count: pending.candidates ?? "?" })], ok: t("scan.collect.again") })) return;
  if (S.scope.kind === "all" && !await ask({ title: t("scan.collect.all.conversations"), lines: [t("scan.downloading.all.content.can.take.minutes.or")], ok: t("scan.start.collection") })) return;
  try { S.forceStep = null; await post("/maintenance/scan", scanBody()); await refreshSession(); } catch (e) { fail(e); }
}

async function startPartialScan() {
  const pending = pendingRun();
  if (pending && !await ask({ title: t("scan.continue.with.collected.conversations"), lines: [t("scan.replaceWithPartialWarning", { scope: scopeLabel(pending.scope), count: pending.candidates ?? "?" })], ok: t("scan.continue") })) return;
  try { S.forceStep = null; await post("/maintenance/scan/partial"); await refreshSession(); } catch (e) { fail(e); }
}

async function startProjectList() {
  try { await post("/maintenance/projects"); await refreshSession(); } catch (e) { fail(e); }
}

// 삭제후보 프로젝트의 지금 대화를 읽어, 직접 지우거나 옮긴 대화를 목록에서 뺀다(읽기 전용).
export async function startTrashSync() {
  try { await post("/maintenance/trash/sync"); await refreshSession(); } catch (e) { fail(e); }
}
