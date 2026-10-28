// 바뀌는 내용 검토 패널: 요약, 예외 목록, 수정, 적용 확인.
import { buildReviewSummary, rowsFromProposal } from "/assets/shared/summary.js";
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
    if (!proposal.ready) { fill($("panel"), h("p", { text: "분류 제안이 아직 없습니다." })); return; }
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
  const ex = summary.exceptions; const c = summary.changes; const t = summary.totals;
  const invalid = rows.filter((r) => r.decision === "keep" && !S.overrides.get(r.conversationId)?.skipTitle && !isNormalizedTitle(r.newTitle || r.title));
  const blockers = [];
  if (t.undecided) blockers.push(`미결정 ${t.undecided}건을 정해 주세요`);
  if (invalid.length) blockers.push(`제목 형식이 맞지 않는 대화 ${invalid.length}건 — ‘바뀌는 대화’ 목록에서 제목을 고쳐 주세요`);
  const dests = destinationEntries();
  const panel = $("panel");
  fill(panel, 
    h("p", { class: "lead", text: summary.headline }),
    S.session?.run?.skipped?.length ? skippedCallout(S.session.run.skipped) : null,
    h("div", { class: "chips" }, h("span", { class: "chip", text: `후보 ${t.candidates}건` }), h("span", { class: "chip good", text: `보존 ${t.keep}건` }),
      t.delete ? h("span", { class: "chip warn", text: `영구 삭제 ${t.delete}건` }) : null, t.trashed ? h("span", { class: "chip", text: `삭제후보로 이동 ${t.trashed}건` }) : null, t.marked ? h("span", { class: "chip", text: `삭제후보 표시 ${t.marked}건` }) : null, t.undecided ? h("span", { class: "chip bad", text: `미결정 ${t.undecided}건` }) : null,
      c.remove ? h("span", { class: "chip warn", text: `직접 빼야 할 대화 ${c.remove}건` }) : null),
    projectTable(summary),
    trashControl(t.delete + t.trashed + t.marked),
    section("결정이 필요한 항목(미결정)", ex.undecided.length, ex.undecided.map((d) => item(d.title, d.why || "판단 근거 없음", [
      h("button", { class: "btn ghost", type: "button", onclick: () => patch(d.conversationId, { decision: "keep", project: d.project || "" }) }, "보존"),
      h("button", { class: "btn ghost", type: "button", onclick: () => patch(d.conversationId, { decision: "delete" }) }, S.trash.permanent ? "영구 삭제" : "삭제후보로")])), true),
    destinationSection(dests),
    section("확신이 낮은 항목", ex.lowConfidence.length, ex.lowConfidence.map((d) => item(d.title, d.why || "", [])), false),
    c.newProjects.length ? section("새로 만들 프로젝트", c.newProjects.length, c.newProjects.map((n) => item(n, "적용할 때 자동으로 만듭니다", [])), true, "", "개") : null,
    ex.manualRemoves.length ? section("직접 빼야 하는 대화", ex.manualRemoves.length, ex.manualRemoves.map((m) => item(m.title, `현재 프로젝트: ${m.project} — 앱은 프로젝트에서 뺄 수 없어 결과 화면에 안내합니다`, [])), false) : null,
    reviseGuide(),
    h("div", { class: "applybar" }, h("div", {}, h("strong", { id: "apply-state" }), h("div", { class: "small down", id: "apply-blockers" })),
      h("button", { class: "btn", type: "button", id: "apply-button", onclick: () => confirmApply(summary) }, "적용")));
  S.applyBlockers = blockers;
  syncApplyBar();
}

const RELAY_DOWN = "ChatGPT 연결이 끊겨 있습니다 — chatgpt.com 탭에서 북마클릿을 눌러 주세요";

// 적용 버튼과 막힌 이유를 지금 상태(연결 여부 포함)에 맞춘다. 화면이 갱신될 때마다 부른다.
function syncApplyBar() {
  const button = $("apply-button"); const box = $("apply-blockers"); const state = $("apply-state");
  if (!button || !box) return;
  const reasons = [...(S.applyBlockers || []), ...(S.session?.relay?.connected ? [] : [RELAY_DOWN])];
  button.disabled = reasons.length > 0;
  state.textContent = reasons.length ? "적용하기 전에 해결할 것이 있습니다" : "적용할 수 있습니다";
  box.textContent = reasons.join(" · "); box.hidden = reasons.length === 0;
}

// 삭제후보를 옮겨 둘 프로젝트. auto 는 기본 이름의 삭제후보 프로젝트(없으면 새로 만든다).
// fixed 는 정해 둔 프로젝트이고, 이번 확인에서 본 프로젝트 목록에 없으면 기본 이름의 삭제후보 프로젝트를 새로 만들어 옮긴다.
function trashTarget() {
  if (S.trash.mode === "fixed") {
    const exists = (S.catalog?.projects || []).some((project) => project.projectName === S.trash.name);
    if (exists) return { name: S.trash.name, fallback: false };
    return { name: S.trashDefault, fallback: true };
  }
  return { name: S.trashDefault, fallback: false };
}

// 삭제후보를 어떻게 다룰지 고른다. 기본은 삭제후보 프로젝트로 옮기는 것이며 영구 삭제는 고급 접힘 안에 있다.
function saveTrash() { try { localStorage.setItem("app_trash", JSON.stringify({ mode: S.trash.mode, name: S.trash.name })); } catch {} }

// 마음에 들지 않을 때: 화면에서 직접 고치거나, 제안 자체를 에이전트에게 고쳐 달라고 요청한다.
// 요청문의 회색 이탤릭 부분이 사용자가 바꿔 적을 자리다(복사하면 그 문구가 그대로 붙으니 지우고 내용을 적는다).
const REVISE_HEAD = "이 저장소에서 `npm run brief`를 실행해 현재 분류 제안(proposal.json)을 읽고, 아래만 고쳐서 다시 저장한 뒤 validate-proposal로 검증해줘. 나머지는 그대로 둬.";
const REVISE_FILL = "바꾸고 싶은 내용을 여기에 적으세요. 예) 「대화 제목」은 삭제하지 말고 보존 / 「대화 제목」의 제목을 ○○로 / 「대화 제목」을 ○○ 프로젝트로";
const REVISE_PROMPT = `${REVISE_HEAD}\n- ${REVISE_FILL}`;

function reviseGuide() {
  return h("details", { "data-key": "제안 수정 안내" }, h("summary", { text: "제안이 마음에 들지 않으면" }), h("div", { class: "body" },
    h("p", { class: "small", text: "작은 수정은 위 목록에서 직접 고칩니다. 제안 자체를 바꾸려면 아래 요청문에서 회색 이탤릭 부분을 지우고 바꿀 내용을 적어 에이전트에게 전달한 뒤 ‘제안 다시 불러오기’를 누르세요." }),
    h("div", { class: "callout" }, h("div", { text: REVISE_HEAD }), h("div", {}, "- ", h("em", { class: "fill", text: REVISE_FILL }))),
    h("div", { class: "row" },
      h("button", { class: "btn ghost", type: "button", onclick: async (e) => { await navigator.clipboard.writeText(REVISE_PROMPT); e.target.textContent = "복사됨"; } }, "요청문 복사"),
      h("button", { class: "btn ghost", type: "button", onclick: () => loadReview() }, "제안 다시 불러오기"))));
}

function trashControl(candidates) {
  if (!candidates) return null;
  const set = (changes) => { Object.assign(S.trash, changes); saveTrash(); redraw(); };
  const radio = (value) => h("input", { type: "radio", name: "trash-mode", checked: S.trash.mode === value && !S.trash.permanent ? true : null,
    onchange: () => set({ mode: value, permanent: false }) });
  // 정해 둔 프로젝트는 이름을 손으로 쓰지 않고 목록에서 고른다. 목록에 없으면 새 이름으로 만들거나 프로젝트 링크를 붙여 넣는다.
  const known = S.session?.knownProjects?.projects || [];
  const names = [...new Set([...known.map((p) => p.name), ...(S.catalog?.projects || []).map((p) => p.projectName)])].filter((n) => n !== S.trashDefault);
  const NEW = "__new__";
  const isListed = names.includes(S.trash.name);
  const select = h("select", { onchange: (e) => {
    if (e.target.value === NEW) set({ mode: "fixed", name: "", permanent: false, choosingNew: true });
    else set({ mode: "fixed", name: e.target.value, permanent: false, choosingNew: false });
  } }, h("option", { value: "", text: "프로젝트 고르기…" }), ...names.map((n) => h("option", { value: n, text: n })), h("option", { value: NEW, text: "＋ 새 프로젝트 이름으로 만들기" }));
  select.value = S.trash.choosingNew ? NEW : (isListed ? S.trash.name : "");
  const newName = S.trash.choosingNew ? h("input", { type: "text", size: "20", placeholder: "새 프로젝트 이름", value: S.trash.name,
    onchange: (e) => { const v = e.target.value.trim(); set(v ? { mode: "fixed", name: v, permanent: false, choosingNew: true } : {}); } }) : null;
  const link = h("input", { type: "text", size: "24", placeholder: "또는 프로젝트 링크 붙여넣기", onchange: (e) => {
    const id = projectIdFromLink(e.target.value); e.target.value = "";
    const project = id ? known.find((p) => p.id === id) : null;
    if (!id) toast("프로젝트 링크가 아닙니다", "ChatGPT에서 프로젝트를 연 주소(…/g/g-p-…/project)를 붙여 넣어 주세요.");
    else if (!project) toast("목록에 없는 프로젝트입니다", "첫 화면의 ‘프로젝트 목록 새로 읽기’ 뒤 다시 붙여 넣어 보세요.");
    else set({ mode: "fixed", name: project.name, permanent: false, choosingNew: false });
  } });
  const target = trashTarget();
  return h("div", { class: "callout" },
    h("strong", { text: "삭제후보 처리 방식" }),
    h("label", { class: "check" }, radio("auto"), `「${S.trashDefault}」 프로젝트로 이동(기본, 없으면 새로 만듭니다)`),
    h("label", { class: "check" }, radio("fixed"), "정해 둔 프로젝트로 이동 → ", select, newName, link,
      S.trash.mode === "fixed" && (!S.trash.name || target.fallback) ? h("span", { class: "small down", text: S.trash.name ? ` 그런 프로젝트가 없어 「${target.name}」를 새로 만들어 옮깁니다` : " 프로젝트를 고르지 않으면 「" + target.name + "」로 옮깁니다" }) : null),
    h("label", { class: "check" }, radio("none"), "이동 없이 표시만(프로젝트 안의 대화는 앱이 뺄 수 없어 직접 빼야 합니다)"),
    h("details", {}, h("summary", { text: "고급 — 영구 삭제" }), h("div", { class: "body" },
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: S.trash.permanent ? true : null, onchange: (e) => set({ permanent: e.target.checked }) }),
        "삭제후보를 옮기지 않고 바로 영구 삭제합니다(되돌릴 수 없음)"))));
}

function section(title, count, items, open, note = "", unit = "건", extra = "") {
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
    state.all ? h("span", { class: "small muted", text: `전체 ${list.length}건 표시 중` }) : [
      h("button", { class: "btn ghost", type: "button", disabled: state.page === 0 ? true : null, onclick: () => go({ page: state.page - 1 }) }, "‹ 이전"),
      h("span", { class: "small", text: `${state.page + 1} / ${pages}쪽 · ${state.page * PAGE_SIZE + 1}–${Math.min(list.length, (state.page + 1) * PAGE_SIZE)} / ${list.length}건` }),
      h("button", { class: "btn ghost", type: "button", disabled: state.page === pages - 1 ? true : null, onclick: () => go({ page: state.page + 1 }) }, "다음 ›")],
    h("button", { class: "btn ghost", type: "button", onclick: () => go({ all: !state.all }) }, state.all ? "쪽으로 나누어 보기" : "전체 한 번에 보기"));
  return [bar("top"), shown.map((x) => render(x)), bar("bottom")];
}

// ---------- 바뀌는 대화: 이동·삭제후보·제목 변경을 대화 한 줄에서 함께 다룬다 ----------
// 대화마다 "어디로 보낼까"(삭제후보 · 프로젝트 없음 · 각 프로젝트)와 "제목을 무엇으로 바꿀까"를 같은 자리에서 고친다.
// 적용 체크를 해제하면 그 대화는 원래 자리·원래 제목 그대로 둔다.
const TRASH_VALUE = "__trash__";
const DEST_KEY = "바뀌는 대화";
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
  if (S.trash.permanent) return "삭제(영구 · 되돌릴 수 없음)";
  if (S.trash.mode === "none") return "삭제후보로 표시만(이동 없음)";
  return `삭제후보로 보내기 → 「${trashTarget().name}」`;
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
  const scope = { all: "", move: "프로젝트 이동 ", trash: "삭제후보 ", title: "제목만 바꾸는 " }[destFilter];
  const listOff = list.filter((e) => e.off).length;
  const note = list.length > PAGE_SIZE ? "모두 적용·해제는 이 탭의 다른 쪽 항목까지 바꿉니다." : "";
  const tabs = [tab("all", "전체", all.length), tab("move", "프로젝트 이동", count("move")), tab("trash", "삭제후보", count("trash")), tab("title", "제목만", count("title"))];
  return section(DEST_KEY, all.length, [
    h("div", { class: "seg" }, tabs),
    h("div", { class: "bulk" },
      h("button", { class: "btn link", type: "button", disabled: listOff === 0 ? true : null, onclick: bulk(false) }, `${scope}모두 적용`),
      h("button", { class: "btn link", type: "button", disabled: listOff === list.length ? true : null, onclick: bulk(true) }, `${scope}모두 해제`),
      note ? h("span", { class: "muted small", text: note }) : null),
    list.length ? paged(DEST_KEY, list, destinationItem) : h("p", { class: "muted small", text: "이 탭에 항목이 없습니다." })],
  true, "대화마다 보낼 곳과 새 제목을 한 줄에서 고칩니다. 삭제후보로 제안된 대화도 다른 프로젝트로 보낼 수 있고, ‘프로젝트 없음’을 고르면 현재 프로젝트 안의 대화는 결과 화면에서 직접 빼도록 안내합니다.",
  "건", off ? `${all.length - off}건 적용` : "");
}

// "수정"을 누른 대화는 제목 입력칸을 연다. 제목 형식이 맞지 않는 대화는 늘 열려 있어 고치기 전에는 적용할 수 없다.
const editingTitle = new Set();

function destinationItem(e) {
  const id = e.conversationId;
  const toggle = h("label", { class: "check apply-toggle" }, h("input", { type: "checkbox", "data-fk": `c:dest:${id}`, checked: e.off ? null : true,
    onchange: (ev) => patchMany([id], releaseChanges(e, !ev.target.checked)) }), "적용");
  const select = h("select", { "data-fk": `m:${id}`, onchange: (ev) => {
    const v = ev.target.value;
    patch(id, v === TRASH_VALUE ? { decision: "delete", project: undefined, skipMove: false, skipTitle: false, listed: true }
      : { decision: "keep", project: v, skipMove: false, skipTitle: false, listed: true });
  } }, h("option", { value: TRASH_VALUE, text: trashLabel() }), h("option", { value: "", text: "프로젝트 없음" }),
    ...projectNames().map((n) => h("option", { value: n, text: n })));
  select.value = e.groupTrash ? TRASH_VALUE : (e.to || "");
  const from = e.from || "프로젝트 없음";
  const route = h("div", { class: "route" },
    e.groupTrash || e.moving ? [h("span", { class: "from", text: from }), h("span", { class: "arrow", "aria-hidden": "true", text: "→" })]
      : h("span", { class: "from", text: "프로젝트는 그대로" }),
    select);
  // 영구 삭제는 제목이 필요 없다. 프로젝트만 옮기는 대화는 제목을 그대로 둘 수도 있어 그 경우만 따로 해제한다.
  const canKeepTitle = e.moving && !e.groupTrash;
  const keepTitle = !e.off && canKeepTitle
    ? h("label", { class: "check apply-toggle" }, h("input", { type: "checkbox", "data-fk": `c:title:${id}`, checked: e.titleOff ? true : null,
      onchange: (ev) => patch(id, { skipTitle: ev.target.checked }) }), "제목 그대로") : null;
  let rename = null;
  if (e.kind !== "delete") {
    if (e.off) rename = h("div", { class: "rename muted", text: "해제됨 — 원래 제목 그대로 둡니다" });
    else if (e.titleOff && canKeepTitle) rename = h("div", { class: "rename muted" }, "제목은 그대로 둡니다", keepTitle);
    else if (editingTitle.has(id) || !isNormalizedTitle(e.effTitle)) {
      rename = h("div", { class: "rename" }, h("input", { class: `title-input${isNormalizedTitle(e.effTitle) ? "" : " invalid"}`, type: "text", value: e.effTitle, "data-fk": `t:${id}`,
        placeholder: "새 제목 (주제 — 작업/결과)", onchange: (ev) => {
          const v = ev.target.value.trim(); ev.target.classList.toggle("invalid", !isNormalizedTitle(v));
          if (isNormalizedTitle(v)) editingTitle.delete(id);
          patch(id, { title: v, skipTitle: false, listed: true });
        } }), keepTitle);
    } else {
      rename = h("div", { class: "rename" }, h("span", { class: "muted", text: e.renaming ? "새 제목" : "제목 유지" }), e.renaming ? h("span", { class: "newtitle", text: e.effTitle }) : null,
        h("button", { class: "btn link", type: "button", onclick: () => { editingTitle.add(id); focusRequest = `t:${id}`; redraw(); } }, "수정"), keepTitle);
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
  return h("details", { open: true, "data-key": "프로젝트별 변화" }, h("summary", { text: `프로젝트별 변화 (${rows.length}개)` }), h("div", { class: "body" },
    h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "프로젝트" }), h("th", { class: "num", text: "이전" }), h("th", { class: "num", text: "이후" }), h("th", { class: "num", text: "변화" }))),
      h("tbody", {}, rows.map((p) => h("tr", {}, h("td", { text: `${p.name}${p.isNew ? " (신규)" : ""}` }), h("td", { class: "num", text: p.before ?? "—" }), h("td", { class: "num", text: p.after ?? "—" }),
        h("td", { class: `num ${p.delta > 0 ? "up" : "down"}`, text: `${p.delta > 0 ? "+" : ""}${p.delta}` })))))));
}

async function confirmApply(summary) {
  const { delete: deletes, trashed, marked } = summary.totals;
  const lines = ["ChatGPT의 대화가 실제로 바뀝니다. 적용은 끝날 때까지 자동으로 이어지며(429·일시 오류는 기다렸다 재개) 이 화면을 닫아도 서버가 계속합니다.",
    trashed ? `삭제후보 ${trashed}건은 지우지 않고 「${trashTarget().name}」로 옮깁니다.` : "",
    marked ? `삭제후보 ${marked}건은 이동 없이 표시만 합니다. 직접 지우세요.` : ""].filter(Boolean);
  const ok = await ask({ title: summary.headline, lines, ok: "적용 시작", ack: deletes ? `영구 삭제 ${deletes}건은 되돌릴 수 없음을 확인했습니다` : null });
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
