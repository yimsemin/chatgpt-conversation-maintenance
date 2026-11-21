// 바뀌는 내용 검토 패널: 요약, 예외 목록, 수정, 적용 확인.
import { locale, t } from "/assets/language.js";
import { buildReviewSummary, rowsFromProposal, summaryHeadline } from "/assets/shared/summary.js";
import { isNormalizedTitle } from "/assets/shared/title-rules.js";
import { S } from "/assets/state.js";
import { $, ask, fill, h } from "/assets/dom.js";
import { projectIdFromLink } from "/assets/shared/project-link.js";
import { api, fail, post, toast } from "/assets/net.js";
import { refreshSession } from "/assets/session-client.js";
import { skippedCallout } from "/assets/panel-scan.js";

// ---------- step 3: review ----------
export async function loadReview() {
  try {
    const [proposal, catalog] = await Promise.all([api("/maintenance/proposal"), api("/maintenance/catalog")]);
    S.proposal = proposal; S.catalog = catalog;
    if (!proposal.ready) { fill($("panel"), h("p", { text: t("review.noProposal") })); return; }
    loadOverrides();
    drawReview();
    if (!S.live.includes(syncApplyBar)) S.live.push(syncApplyBar);
  } catch (e) { fail(e); }
}

// ignoreSkips: 바뀌는 대화 목록은 "적용 안 함"으로 해제한 항목도 계속 보여 줘야 다시 켤 수 있다.
function effectiveRows(ignoreSkips = false) {
  const rows = rowsFromProposal(S.proposal, { conversations: [] });
  return rows.map((row) => {
    const o = S.overrides.get(row.conversationId); if (!o) return row;
    const next = { ...row, undecided: false };
    if (o.decision) next.decision = o.decision;
    if (o.title !== undefined) next.newTitle = o.title;
    if (o.project !== undefined) next.project = o.project || null;
    if (o.decision === "keep" && o.project === undefined && !row.project) next.project = row.currentProject;
    if (!ignoreSkips && o.skipMove) { if (next.decision === "delete") next.decision = "keep"; next.project = row.currentProject || null; }
    if (!ignoreSkips && o.skipTitle) next.newTitle = row.title;
    return next;
  }).map((row) => {
    if (row.decision !== "delete" || S.trash.permanent) return row;
    // 삭제후보는 곧바로 지우지 않는다. 삭제후보 프로젝트로 옮기거나(기본), 옮기지 않고 표시만 한다. 어느 쪽이든 표준 제목을 갖는다.
    if (S.trash.mode === "none") return { ...row, decision: "keep", project: row.currentProject, marked: true };
    return { ...row, decision: "keep", project: trashTarget().name, trashed: true };
  });
}

// 검토 중 바꾼 내용은 새로고침해도 남도록 실행별로 저장한다.
const overrideKey = () => `app_overrides_${S.session?.run?.id || ""}`;

function saveOverrides() { try { localStorage.setItem(overrideKey(), JSON.stringify([...S.overrides])); } catch {} }

function loadOverrides() {
  try { S.overrides = new Map(JSON.parse(localStorage.getItem(overrideKey()) || "[]")); } catch { S.overrides = new Map(); }
}

// 화면을 다시 그릴 때 펼침 상태·스크롤·입력 위치를 보존한다(항목 하나를 고칠 때마다 목록이 닫히지 않게).
// change 는 포커스가 옮겨 가기 전에 오므로 다음 틱에 그려야 사용자가 옮겨 간 칸을 기억할 수 있다.
let redrawTimer = null; let focusRequest = null;
function redraw() {
  if (redrawTimer) return;
  redrawTimer = setTimeout(() => {
    redrawTimer = null;
    const panel = $("panel"); if (!panel) return;
    const open = new Set([...panel.querySelectorAll("details[data-key][open]")].map((d) => d.dataset.key));
    const known = new Set([...panel.querySelectorAll("details[data-key]")].map((d) => d.dataset.key));
    const active = document.activeElement; const focusKey = focusRequest || active?.dataset?.fk || null;
    const caret = !focusRequest && focusKey && typeof active.selectionStart === "number" ? [active.selectionStart, active.selectionEnd] : null;
    focusRequest = null;
    const { scrollX, scrollY } = window;
    drawReview();
    for (const d of $("panel").querySelectorAll("details[data-key]")) if (known.has(d.dataset.key)) d.open = open.has(d.dataset.key);
    if (focusKey) {
      const next = [...$("panel").querySelectorAll("[data-fk]")].find((el) => el.dataset.fk === focusKey);
      if (next) { next.focus({ preventScroll: true }); if (caret && typeof next.setSelectionRange === "function") try { next.setSelectionRange(...caret); } catch {} }
    }
    window.scrollTo(scrollX, scrollY);
    if (scrollToKey) {
      $("panel").querySelector(`details[data-key="${scrollToKey}"] summary`)?.scrollIntoView({ block: "start" });
      scrollToKey = null;
    }
  }, 0);
}

const patchMany = (ids, changes) => {
  for (const id of ids) S.overrides.set(id, { ...(S.overrides.get(id) || {}), ...changes });
  saveOverrides(); redraw();
};
const patch = (id, changes) => patchMany([id], changes);

export function projectNames() {
  const names = new Set((S.catalog?.projects || []).map((p) => p.projectName));
  for (const item of S.proposal?.items || []) if (item.suggestedProjectName) names.add(item.suggestedProjectName);
  return [...names].sort((a, b) => a.localeCompare(b));
}

function drawReview() {
  const rows = effectiveRows();
  const summary = buildReviewSummary({ catalog: S.catalog, rows });
  const ex = summary.exceptions; const c = summary.changes; const totals = summary.totals;
  const invalid = rows.filter((r) => r.decision === "keep" && !S.overrides.get(r.conversationId)?.skipTitle && !isNormalizedTitle(r.newTitle || r.title));
  const blockers = [];
  if (totals.undecided) blockers.push(t("review.decideRemaining", { count: totals.undecided }));
  if (invalid.length) blockers.push(t("review.invalidTitles", { count: invalid.length }));
  const dests = destinationEntries();
  const panel = $("panel");
  fill(panel, 
    h("p", { class: "lead", text: summaryHeadline(summary, locale) }),
    S.session?.run?.skipped?.length ? skippedCallout(S.session.run.skipped) : null,
    h("div", { class: "chips" }, h("span", { class: "chip", text: t("review.candidates", { count: totals.candidates }) }), h("span", { class: "chip good", text: t("review.keepCount", { count: totals.keep }) }),
      totals.delete ? h("span", { class: "chip warn", text: t("review.permanentDeleteCount", { count: totals.delete }) }) : null, totals.trashed ? h("span", { class: "chip", text: t("review.trashedCount", { count: totals.trashed }) }) : null, totals.marked ? h("span", { class: "chip", text: t("review.markedCount", { count: totals.marked }) }) : null, totals.undecided ? h("span", { class: "chip bad", text: t("review.undecided", { count: totals.undecided }) }) : null,
      c.remove ? h("span", { class: "chip warn", text: t("review.manualRemoveCount", { count: c.remove }) }) : null),
    projectTable(summary),
    trashControl(totals.delete + totals.trashed + totals.marked),
    section(t("review.needsDecision"), ex.undecided.length, ex.undecided.map((d) => item(d.title, d.why || t("review.noReason"), [
      h("button", { class: "btn ghost", type: "button", onclick: () => patch(d.conversationId, { decision: "keep", project: d.project || "" }) }, t("review.keep")),
      h("button", { class: "btn ghost", type: "button", onclick: () => patch(d.conversationId, { decision: "delete" }) }, S.trash.permanent ? t("review.permanently.delete") : t("review.optionTrash"))])), true),
    destinationSection(dests),
    section(t("review.low.confidence"), ex.lowConfidence.length, ex.lowConfidence.map((d) => item(d.title, d.why || "", [])), false),
    c.newProjects.length ? section(t("review.projectsToCreate"), c.newProjects.length, c.newProjects.map((n) => item(n, t("review.createdOnApply"), [])), true, "", t("review.projects")) : null,
    ex.manualRemoves.length ? section(t("review.manualRemoveHeading"), ex.manualRemoves.length, ex.manualRemoves.map((m) => item(m.title, t("review.currentProjectManual", { project: m.project }), [])), false) : null,
    reviseGuide(),
    h("div", { class: "row applybar" },
      h("p", { class: "small down", id: "apply-blockers", hidden: true }),
      h("button", { class: "btn", type: "button", id: "apply-button", "aria-describedby": "apply-blockers", onclick: () => confirmApply(summary) }, t("review.apply"))));
  S.applyBlockers = blockers;
  syncApplyBar();
}

const relayDownReason = () => t(S.relayLocal?.needsUpdate ? "app.bookmarkletOutdated" : "review.relayDown");

// 적용 버튼과 막힌 이유를 지금 상태(연결 여부 포함)에 맞춘다. 화면이 갱신될 때마다 부른다.
function syncApplyBar() {
  const button = $("apply-button"); const box = $("apply-blockers");
  if (!button || !box) return;
  const reasons = [...(S.applyBlockers || []), ...(S.session?.relay?.connected ? [] : [relayDownReason()])];
  button.disabled = reasons.length > 0;
  box.textContent = reasons.join(" · "); box.hidden = reasons.length === 0;
}

// 삭제후보를 옮겨 둘 프로젝트. auto 는 기본 이름의 삭제후보 프로젝트(없으면 새로 만든다).
// fixed 는 정해 둔 프로젝트이고, 이번 확인에서 본 프로젝트 목록에 없으면 기본 이름의 삭제후보 프로젝트를 새로 만들어 옮긴다.
function trashTarget() {
  const tracked = S.session?.trash;
  const defaultProject = tracked?.project || S.trashDefault;
  if (tracked?.count > 0) return { name: defaultProject, fallback: false };
  if (S.trash.mode === "fixed") {
    const exists = (S.catalog?.projects || []).some((project) => project.projectName === S.trash.name);
    if (exists) return { name: S.trash.name, fallback: false };
    return { name: defaultProject, fallback: true };
  }
  return { name: defaultProject, fallback: false };
}

// 삭제후보를 어떻게 다룰지 고른다. 기본은 삭제후보 프로젝트로 옮기는 것이며 영구 삭제는 고급 접힘 안에 있다.
function saveTrash() { try { localStorage.setItem("app_trash", JSON.stringify({ mode: S.trash.mode, name: S.trash.name })); } catch {} }

// 마음에 들지 않을 때: 화면에서 직접 고치거나, 제안 자체를 에이전트에게 고쳐 달라고 요청한다.
// 요청문의 회색 이탤릭 부분이 사용자가 바꿔 적을 자리다(복사하면 그 문구가 그대로 붙으니 지우고 내용을 적는다).
const REVISE_HEAD = t("review.revisePrompt");
const REVISE_FILL = t("review.revisePlaceholder");
const REVISE_PROMPT = `${REVISE_HEAD}\n- ${REVISE_FILL}`;

function reviseGuide() {
  return h("details", { "data-key": "revise-proposal" }, h("summary", { text: t("review.wantRevise") }), h("div", { class: "body" },
    h("p", { class: "small", text: t("review.reviseHelp") }),
    h("div", { class: "callout" }, h("div", { text: REVISE_HEAD }), h("div", {}, "- ", h("em", { class: "muted", text: REVISE_FILL }))),
    h("div", { class: "row" },
      h("button", { class: "btn ghost", type: "button", onclick: async (e) => { await navigator.clipboard.writeText(REVISE_PROMPT); e.target.textContent = t("review.copied"); } }, t("review.copy.prompt")),
      h("button", { class: "btn ghost", type: "button", onclick: () => loadReview() }, t("review.reload.proposal")))));
}

function trashControl(candidates) {
  if (!candidates) return null;
  const lockedProject = S.session?.trash?.count > 0;
  const mode = lockedProject && S.trash.mode === "fixed" ? "auto" : S.trash.mode;
  const set = (changes) => { Object.assign(S.trash, changes); saveTrash(); redraw(); };
  const radio = (value) => h("input", { type: "radio", name: "trash-mode", "data-fk": `trash:${value}`, checked: mode === value && !S.trash.permanent ? true : null,
    onchange: () => set({ mode: value, permanent: false }) });
  // 정해 둔 프로젝트는 이름을 손으로 쓰지 않고 목록에서 고른다. 목록에 없으면 새 이름으로 만들거나 프로젝트 링크를 붙여 넣는다.
  const known = S.session?.knownProjects?.projects || [];
  const names = [...new Set([...known.map((p) => p.name), ...(S.catalog?.projects || []).map((p) => p.projectName)])].filter((n) => n !== S.trashDefault);
  const NEW = "__new__";
  const isListed = names.includes(S.trash.name);
  const select = h("select", { "aria-label": t("review.trashProjectLabel"), "data-fk": "trash:project", onchange: (e) => {
    if (e.target.value === NEW) set({ mode: "fixed", name: "", permanent: false, choosingNew: true });
    else set({ mode: "fixed", name: e.target.value, permanent: false, choosingNew: false });
  } }, h("option", { value: "", text: t("review.chooseProject") }), ...names.map((n) => h("option", { value: n, text: n })), h("option", { value: NEW, text: t("review.createProject") }));
  select.value = S.trash.choosingNew ? NEW : (isListed ? S.trash.name : "");
  const newName = S.trash.choosingNew ? h("input", { type: "text", size: "20", "aria-label": t("review.newProjectName"), placeholder: t("review.newProjectName"), "data-fk": "trash:name", value: S.trash.name,
    onchange: (e) => { const v = e.target.value.trim(); set(v ? { mode: "fixed", name: v, permanent: false, choosingNew: true } : {}); } }) : null;
  const link = h("input", { type: "text", size: "24", "data-fk": "trash:link", onchange: (e) => {
    const id = projectIdFromLink(e.target.value); e.target.value = "";
    const project = id ? known.find((p) => p.id === id) : null;
    if (!id) toast(t("review.notProjectLink"), t("review.pasteUrlHelp"));
    else if (!project) toast(t("review.projectNotInList"), t("review.refreshListHint"));
    else set({ mode: "fixed", name: project.name, permanent: false, choosingNew: false });
  } });
  const target = trashTarget();
  return h("div", { class: "callout" },
    h("strong", { text: t("review.trashHandling") }),
    h("label", { class: "check" }, radio("auto"), t("review.moveToDefault", { project: S.session?.trash?.project || S.trashDefault })),
    lockedProject ? h("p", { class: "small muted", text: t("review.existingTrashProject") })
      : h("label", { class: "check" }, radio("fixed"), t("review.moveToChosen")),
    mode === "fixed" && !S.trash.permanent ? [
      h("div", { class: "row" }, select, newName),
      h("label", { class: "row small muted" }, t("review.orPasteLink"), link),
      target.fallback ? h("p", { class: "small down", text: S.trash.name ? t("review.projectUnavailable", { project: target.name }) : t("review.noProjectSelected", { project: target.name }) }) : null,
    ] : null,
    h("label", { class: "check" }, radio("none"), t("review.markInPlaceHelp")),
    h("details", {}, h("summary", { text: t("review.advancedPermanentDeletion") }), h("div", { class: "body" },
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: S.trash.permanent ? true : null, onchange: (e) => set({ permanent: e.target.checked }) }),
        t("review.permanentOptionHelp")))));
}

function section(title, count, items, open, note = "", unit = t("review.items"), extra = "") {
  if (!count) return null;
  return h("details", { open: open || null, "data-key": title }, h("summary", { text: `${title} (${count}${unit}${extra ? ` · ${extra}` : ""})` }), h("div", { class: "body" }, note ? h("p", { class: "muted small", text: note }) : null, [items].flat(Infinity)));
}

// 긴 목록은 200건씩 나눠 보여 준다(한 화면에 수천 줄을 그리면 느려진다). 기본은 쪽 나누기, "전체 보기"로 한 번에 펼칠 수 있다.
// 쪽·전체 보기는 화면을 다시 그려도 유지되고, 200건 이하인 목록에는 아무것도 붙지 않는다.
const PAGE_SIZE = 200;
const pageState = new Map(); let scrollToKey = null;

function paged(key, list, render) {
  if (list.length <= PAGE_SIZE) return list.map((x) => render(x));
  const state = pageState.get(key) || { page: 0, all: false };
  const pages = Math.ceil(list.length / PAGE_SIZE);
  state.page = Math.min(state.page, pages - 1); pageState.set(key, state);
  const shown = state.all ? list : list.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
  const go = (changes) => { Object.assign(state, changes); scrollToKey = key; redraw(); };
  const bar = (position) => h("div", { class: "pager", "data-pos": position },
    state.all ? h("span", { class: "small muted", text: t("review.showing.all", { count: list.length }) }) : [
      h("button", { class: "btn ghost", type: "button", disabled: state.page === 0 ? true : null, onclick: () => go({ page: state.page - 1 }) }, t("review.previous")),
      h("span", { class: "small", text: t("review.pageOf", { page: state.page + 1, pages: pages, first: state.page * PAGE_SIZE + 1, last: Math.min(list.length, (state.page + 1) * PAGE_SIZE), total: list.length }) }),
      h("button", { class: "btn ghost", type: "button", disabled: state.page === pages - 1 ? true : null, onclick: () => go({ page: state.page + 1 }) }, t("review.next"))],
    h("button", { class: "btn ghost", type: "button", onclick: () => go({ all: !state.all }) }, state.all ? t("review.show.pages") : t("review.show.all")));
  return [bar("top"), shown.map((x) => render(x)), bar("bottom")];
}

// ---------- 바뀌는 대화: 이동·삭제후보·제목 변경을 대화 한 줄에서 함께 다룬다 ----------
// 대화마다 "어디로 보낼까"(삭제후보 · 프로젝트 없음 · 각 프로젝트)와 "제목을 무엇으로 바꿀까"를 같은 자리에서 고친다.
// 적용 체크를 해제하면 그 대화는 원래 자리·원래 제목 그대로 둔다.
const TRASH_VALUE = "__trash__";
const DEST_KEY = t("review.changesHeading");
let destFilter = "all"; // all | move | trash | title

function destinationEntries() {
  const entries = [];
  for (const r of effectiveRows(true)) {
    if (r.undecided) continue;
    const o = S.overrides.get(r.conversationId);
    const kind = r.trashed ? "trash" : r.marked ? "mark" : r.decision === "delete" ? "delete" : "move";
    const moving = Boolean(r.project) && r.project !== r.currentProject;
    const effTitle = (r.newTitle || r.title).trim();
    const renaming = effTitle !== (r.title || "").trim();
    if (kind === "move" && !moving && !renaming && !o?.listed) continue;
    const groupTrash = kind !== "move";
    const changesPlace = groupTrash || moving;
    entries.push({ conversationId: r.conversationId, title: r.title, from: r.currentProject, kind, to: r.project, groupTrash, moving, renaming, effTitle,
      group: groupTrash ? "trash" : moving ? "move" : "title",
      off: Boolean(changesPlace ? o?.skipMove : o?.skipTitle), titleOff: Boolean(o?.skipTitle) });
  }
  return entries;
}

function trashLabel() {
  if (S.trash.permanent) return t("review.deleteOptionPermanent");
  if (S.trash.mode === "none") return t("review.optionMarkInPlace");
  return t("review.moveToTrash", { project: trashTarget().name });
}

// 해제는 대화를 원래 자리·원래 제목 그대로 두는 것이다(해제한 대화는 표준 제목 예외). 다시 켜면 이동·제목 변경이 모두 돌아온다.
const releaseChanges = (entry, off) => (entry.group === "title" ? { skipTitle: off } : { skipMove: off, skipTitle: off });

function destinationSection(all) {
  if (!all.length) return null;
  const list = destFilter === "all" ? all : all.filter((e) => e.group === destFilter);
  const off = all.filter((e) => e.off).length;
  const setFilter = (value) => { destFilter = value; pageState.delete(DEST_KEY); redraw(); };
  const count = (group) => all.filter((e) => e.group === group).length;
  const tab = (value, label, n) => h("button", { class: destFilter === value ? "on" : null, type: "button", "data-fk": `f:${value}`,
    "aria-pressed": destFilter === value ? "true" : "false", onclick: () => setFilter(value) }, `${label} ${n}`);
  const bulk = (offValue) => () => {
    for (const group of ["trash", "move", "title"]) {
      const sub = list.filter((e) => e.group === group);
      if (sub.length) patchMany(sub.map((e) => e.conversationId), releaseChanges({ group }, offValue));
    }
  };
  const scope = { all: "", move: t("review.bulkProjectMoves"), trash: t("review.bulkDeletionCandidates"), title: t("review.title.changes") }[destFilter];
  const listOff = list.filter((e) => e.off).length;
  const note = list.length > PAGE_SIZE ? t("review.bulkNote") : "";
  const tabs = [tab("all", t("review.all"), all.length), tab("move", t("review.project.moves"), count("move")), tab("trash", t("review.deletion.candidates"), count("trash")), tab("title", t("review.titles.only"), count("title"))];
  return section(DEST_KEY, all.length, [
    h("div", { class: "seg" }, tabs),
    h("div", { class: "bulk" },
      h("button", { class: "btn link", type: "button", disabled: listOff === 0 ? true : null, onclick: bulk(false) }, t("review.select.all", { scope }).trim()),
      h("button", { class: "btn link", type: "button", disabled: listOff === list.length ? true : null, onclick: bulk(true) }, t("review.deselect.all", { scope }).trim()),
      note ? h("span", { class: "muted small", text: note }) : null),
    list.length ? paged(DEST_KEY, list, destinationItem) : h("p", { class: "muted small", text: t("review.emptyTab") })],
  true, t("review.editHelp"),
  t("review.items"), off ? t("review.selected", { count: all.length - off }) : "");
}

// "수정"을 누른 대화는 제목 입력칸을 연다. 제목 형식이 맞지 않는 대화는 늘 열려 있어 고치기 전에는 적용할 수 없다.
const editingTitle = new Set();

function destinationItem(e) {
  const id = e.conversationId;
  const toggle = h("label", { class: "check" }, h("input", { type: "checkbox", "data-fk": `c:dest:${id}`, checked: e.off ? null : true,
    onchange: (ev) => patchMany([id], releaseChanges(e, !ev.target.checked)) }), t("review.includeChange"));
  const select = h("select", { "data-fk": `m:${id}`, onchange: (ev) => {
    const v = ev.target.value;
    patch(id, v === TRASH_VALUE ? { decision: "delete", project: undefined, skipMove: false, skipTitle: false, listed: true }
      : { decision: "keep", project: v, skipMove: false, skipTitle: false, listed: true });
  } }, h("option", { value: TRASH_VALUE, text: trashLabel() }), h("option", { value: "", text: t("review.no.project") }),
    ...projectNames().map((n) => h("option", { value: n, text: n })));
  select.value = e.groupTrash ? TRASH_VALUE : (e.to || "");
  const from = e.from || t("review.no.project");
  const route = h("div", { class: "row small" },
    e.groupTrash || e.moving ? [h("span", { class: "muted", text: from }), h("span", { class: "arrow", "aria-hidden": "true", text: "→" })]
      : h("span", { class: "muted", text: t("review.keepProject") }),
    select);
  // 영구 삭제는 제목이 필요 없다. 프로젝트만 옮기는 대화는 제목을 그대로 둘 수도 있어 그 경우만 따로 해제한다.
  const canKeepTitle = e.moving && !e.groupTrash;
  const keepTitle = !e.off && canKeepTitle
    ? h("label", { class: "check" }, h("input", { type: "checkbox", "data-fk": `c:title:${id}`, checked: e.titleOff ? true : null,
      onchange: (ev) => patch(id, { skipTitle: ev.target.checked }) }), t("review.keepCurrentTitle")) : null;
  let rename = null;
  if (e.kind !== "delete") {
    if (e.off) rename = h("div", { class: "row small muted", text: t("review.deselectedKeepTitle") });
    else if (e.titleOff && canKeepTitle) rename = h("div", { class: "row small muted" }, t("review.titleStays"), keepTitle);
    else if (editingTitle.has(id) || !isNormalizedTitle(e.effTitle)) {
      rename = h("div", { class: "row small" }, h("input", { class: `title-input${isNormalizedTitle(e.effTitle) ? "" : " invalid"}`, type: "text", value: e.effTitle, "data-fk": `t:${id}`,
        placeholder: t("review.newTitleLabel"), onchange: (ev) => {
          const v = ev.target.value.trim(); ev.target.classList.toggle("invalid", !isNormalizedTitle(v));
          if (isNormalizedTitle(v)) editingTitle.delete(id);
          patch(id, { title: v, skipTitle: false, listed: true });
        } }), keepTitle);
    } else {
      rename = h("div", { class: "row small" }, h("span", { class: "muted", text: e.renaming ? t("review.new.title") : t("review.keep.title") }), e.renaming ? h("span", { text: e.effTitle }) : null,
        h("button", { class: "btn link", type: "button", onclick: () => { editingTitle.add(id); focusRequest = `t:${id}`; redraw(); } }, t("review.edit")), keepTitle);
    }
  }
  return h("div", { class: `item dest${e.off ? " off" : ""}` }, h("div", { class: "t", text: e.title }), h("div", { class: "ctl" }, toggle), route, rename);
}

export function item(title, meta, controls) {
  return h("div", { class: "item" }, h("div", { class: "t", text: title }), h("div", { class: "ctl" }, controls), h("div", { class: "m", text: meta }));
}

function projectTable(summary) {
  const rows = summary.projects.filter((p) => p.delta !== 0 || p.isNew);
  if (!rows.length) return null;
  return h("details", { open: true, "data-key": "project-changes" }, h("summary", { text: t("review.project.changes", { count: rows.length }) }), h("div", { class: "body" },
    h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: t("review.project") }), h("th", { class: "num", text: t("review.before") }), h("th", { class: "num", text: t("review.after") }), h("th", { class: "num", text: t("review.change") }))),
      h("tbody", {}, rows.map((p) => h("tr", {}, h("td", { text: `${p.name}${p.isNew ? t("review.new") : ""}` }), h("td", { class: "num", text: p.before ?? "—" }), h("td", { class: "num", text: p.after ?? "—" }),
        h("td", { class: `num ${p.delta > 0 ? "up" : "down"}`, text: `${p.delta > 0 ? "+" : ""}${p.delta}` })))))));
}

async function confirmApply(summary) {
  const { delete: deletes, trashed, marked } = summary.totals;
  const lines = [t("review.applyNote"),
    trashed ? t("review.moveToTrashSummary", { count: trashed, project: trashTarget().name }) : "",
    marked ? t("review.markInPlaceSummary", { count: marked }) : ""].filter(Boolean);
  const ok = await ask({ title: summaryHeadline(summary, locale), lines, ok: t("review.applyStart"), ack: deletes ? t("review.confirmPermanent", { count: deletes }) : null });
  if (!ok) return;
  try {
    const rows = effectiveRows();
    const decisions = rows.map((r) => r.decision === "delete"
      ? { conversationId: r.conversationId, decision: "delete" }
      : { conversationId: r.conversationId, decision: "keep", newTitle: (r.newTitle || r.title).trim(), projectName: (r.project || "").trim(),
        ...(S.overrides.get(r.conversationId)?.skipTitle ? { keepTitle: true } : {}),
        ...(r.trashed ? { trashed: true } : {}), ...(r.marked ? { marked: true } : {}) });
    const trashedRows = rows.filter((r) => r.trashed);
    await post("/maintenance/decisions", { decisions, trash: trashedRows.length ? {
      project: trashTarget().name, entries: trashedRows.map((r) => ({ conversationId: r.conversationId, reason: r.why, intendedTarget: null })) } : undefined });
    await post("/maintenance/apply", { confirmDeletes: deletes > 0 });
    S.overrides = new Map(); saveOverrides(); S.forceStep = null;
    await refreshSession();
  } catch (e) { fail(e); }
}
