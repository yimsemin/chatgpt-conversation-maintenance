// 바뀌는 내용 검토 패널: 요약, 예외 목록, 수정, 적용 확인.
import { buildReviewSummary, rowsFromProposal } from "/assets/shared/summary.js";
import { isNormalizedTitle } from "/assets/shared/title-rules.js";
import { S } from "/assets/state.js";
import { $, fill, h, meta } from "/assets/dom.js";
import { projectIdFromLink } from "/assets/shared/project-link.js";
import { api, fail, post, toast } from "/assets/net.js";
import { refreshSession } from "/assets/session-client.js";

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
    if (row.decision !== "delete" || S.trash.permanent) return row;
    // 삭제 후보는 곧바로 지우지 않는다. 삭제후보 프로젝트로 옮기거나(기본), 옮기지 않고 표시만 한다. 어느 쪽이든 표준 제목을 갖는다.
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

const patch = (id, changes) => { S.overrides.set(id, { ...(S.overrides.get(id) || {}), ...changes }); saveOverrides(); drawReview(); };

export function projectNames() {
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
  const invalid = rows.filter((r) => r.decision === "keep" && !isNormalizedTitle(r.newTitle || r.title));
  const blockers = [];
  if (t.undecided) blockers.push(`미결정 ${t.undecided}건을 정해 주세요`);
  if (invalid.length) blockers.push(`제목 형식이 맞지 않는 대화 ${invalid.length}건 — 아래 목록에서 제목을 고쳐 주세요`);
  const moveList = ex.moves.slice(0, 200);
  const panel = $("panel");
  fill(panel, 
    h("h2", { text: "3. 바뀌는 내용 검토" }),
    h("p", { class: "lead", text: summary.headline }),
    h("div", { class: "chips" }, h("span", { class: "chip", text: `후보 ${t.candidates}건` }), h("span", { class: "chip good", text: `보존 ${t.keep}건` }),
      h("span", { class: t.delete ? "chip warn" : "chip", text: `삭제 ${t.delete}건` }), t.trashed ? h("span", { class: "chip", text: `삭제후보로 이동 ${t.trashed}건` }) : null, t.marked ? h("span", { class: "chip", text: `삭제 표시 ${t.marked}건` }) : null, t.undecided ? h("span", { class: "chip bad", text: `미결정 ${t.undecided}건` }) : null,
      c.remove ? h("span", { class: "chip warn", text: `직접 빼야 할 대화 ${c.remove}건` }) : null),
    projectTable(summary),
    trashControl(t.delete + t.trashed + t.marked),
    section("삭제후보 프로젝트로 옮길 대화", ex.trashed.length, ex.trashed.map((d) => trashItem(d, rows)), false),
    section("삭제 후보로 표시만 할 대화(이동 없음)", ex.marked.length, ex.marked.map((d) => trashItem(d, rows)), false),
    section("삭제 후보", ex.deletes.length, ex.deletes.map((d) => item(d.title, `${d.project || "프로젝트 없음"} · ${d.why || ""}`, [
      h("button", { class: "btn ghost", type: "button", onclick: () => patch(d.conversationId, { decision: "keep", project: d.project || "" }) }, "보존으로 바꾸기")])), ex.deletes.length > 0 && ex.deletes.length <= 60),
    section("결정이 필요한 항목(미결정)", ex.undecided.length, ex.undecided.map((d) => item(d.title, d.why || "판단 근거 없음", [
      h("button", { class: "btn ghost", type: "button", onclick: () => patch(d.conversationId, { decision: "keep", project: d.project || "" }) }, "보존"),
      h("button", { class: "btn ghost", type: "button", onclick: () => patch(d.conversationId, { decision: "delete" }) }, "삭제")])), true),
    section("프로젝트 이동", ex.moves.length, moveList.map((m) => item(m.title, `${m.from || "프로젝트 없음"} → ${m.to}`, [
      projectSelect(m.to, (v) => patch(m.conversationId, { project: v }))])), false, ex.moves.length > 200 ? `처음 200건만 표시(전체 ${ex.moves.length}건)` : ""),
    section("제목 변경", ex.renames.length, ex.renames.slice(0, 200).map((r) => titleItem(r)), false),
    section("확신이 낮은 항목", ex.lowConfidence.length, ex.lowConfidence.map((d) => item(d.title, d.why || "", [])), false),
    c.newProjects.length ? section("새로 만들 프로젝트", c.newProjects.length, c.newProjects.map((n) => item(n, "적용할 때 자동으로 만듭니다", [])), true, "", "개") : null,
    ex.manualRemoves.length ? section("직접 빼야 하는 대화", ex.manualRemoves.length, ex.manualRemoves.map((m) => item(m.title, `현재 프로젝트: ${m.project} — 앱은 프로젝트에서 뺄 수 없어 결과 화면에 안내합니다`, [])), false) : null,
    reviseGuide(),
    h("div", { class: "applybar" }, h("div", {}, h("strong", { text: summary.headline }), h("div", { class: "small down", id: "apply-blockers" })),
      h("button", { class: "btn", type: "button", id: "apply-button", onclick: () => confirmApply(summary) }, "적용")));
  S.applyBlockers = blockers;
  syncApplyBar();
}

const RELAY_DOWN = "ChatGPT 연결이 끊겨 있습니다 — chatgpt.com 탭에서 북마클릿을 눌러 주세요";

// 적용 버튼과 막힌 이유를 지금 상태(연결 여부 포함)에 맞춘다. 화면이 갱신될 때마다 부른다.
function syncApplyBar() {
  const button = document.getElementById("apply-button"); const box = document.getElementById("apply-blockers");
  if (!button || !box) return;
  const reasons = [...(S.applyBlockers || []), ...(S.session?.relay?.connected ? [] : [RELAY_DOWN])];
  button.disabled = reasons.length > 0;
  box.textContent = reasons.join(" · "); box.hidden = reasons.length === 0;
}

// 삭제 후보를 옮겨 둘 프로젝트. auto 는 기본 이름의 삭제후보 프로젝트(없으면 새로 만든다).
// fixed 는 정해 둔 프로젝트이고, 이번 확인에서 본 프로젝트 목록에 없으면 기본 이름의 삭제후보 프로젝트를 새로 만들어 옮긴다.
function trashTarget() {
  if (S.trash.mode === "fixed") {
    const exists = (S.catalog?.projects || []).some((project) => project.projectName === S.trash.name);
    if (exists) return { name: S.trash.name, fallback: false };
    return { name: S.trashDefault, fallback: true };
  }
  return { name: S.trashDefault, fallback: false };
}

// 삭제 후보를 어떻게 다룰지 고른다. 기본은 삭제후보 프로젝트로 옮기는 것이며 영구 삭제는 고급 접힘 안에 있다.
function saveTrash() { try { localStorage.setItem("app_trash", JSON.stringify({ mode: S.trash.mode, name: S.trash.name })); } catch {} }

// 마음에 들지 않을 때: 화면에서 직접 고치거나, 제안 자체를 에이전트에게 고쳐 달라고 요청한다.
// 요청문의 회색 이탤릭 부분이 사용자가 바꿔 적을 자리다(복사하면 그 문구가 그대로 붙으니 지우고 내용을 적는다).
const REVISE_HEAD = "이 저장소에서 `npm run brief`를 실행해 현재 분류 제안(proposal.json)을 읽고, 아래만 고쳐서 다시 저장한 뒤 validate-proposal로 검증해줘. 나머지는 그대로 둬.";
const REVISE_FILL = "바꾸고 싶은 내용을 여기에 적으세요. 예) 「대화 제목」은 삭제하지 말고 보존 / 「대화 제목」의 제목을 ○○로 / 「대화 제목」을 ○○ 프로젝트로";
const REVISE_PROMPT = `${REVISE_HEAD}\n- ${REVISE_FILL}`;

function reviseGuide() {
  return h("details", {}, h("summary", { text: "제안이 마음에 들지 않으면" }), h("div", { class: "body" },
    h("p", { class: "small", text: "작은 수정은 위 목록에서 직접 고치세요. 제안 자체를 바꾸고 싶으면 아래 요청문을 복사해 회색 이탤릭 부분을 지우고 바꿀 내용을 적어 에이전트에게 전달한 뒤 ‘제안 다시 불러오기’를 누르세요." }),
    h("div", { class: "callout" }, h("div", { text: REVISE_HEAD }), h("div", {}, "- ", h("em", { class: "fill", text: REVISE_FILL }))),
    h("div", { class: "row" },
      h("button", { class: "btn ghost", type: "button", onclick: async (e) => { await navigator.clipboard.writeText(REVISE_PROMPT); e.target.textContent = "복사됨"; } }, "요청문 복사"),
      h("button", { class: "btn ghost", type: "button", onclick: () => loadReview() }, "제안 다시 불러오기"))));
}

function trashControl(candidates) {
  if (!candidates) return null;
  const set = (changes) => { Object.assign(S.trash, changes); saveTrash(); drawReview(); };
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
    h("strong", { text: "삭제 후보는 이렇게 처리합니다" }),
    h("label", { class: "check" }, radio("auto"), `삭제후보 프로젝트를 자동으로 쓰고, 없으면 새로 만들어 옮깁니다 → 「${S.trashDefault}」(기본)`),
    h("label", { class: "check" }, radio("fixed"), "정해 둔 프로젝트로 옮깁니다 → ", select, newName, link,
      S.trash.mode === "fixed" && (!S.trash.name || target.fallback) ? h("span", { class: "small down", text: S.trash.name ? ` 그런 프로젝트가 없어 「${target.name}」를 새로 만들어 옮깁니다` : " 프로젝트를 고르지 않으면 「" + target.name + "」로 옮깁니다" }) : null),
    h("label", { class: "check" }, radio("none"), "옮기지 않고 삭제 후보로 표시만 합니다 (프로젝트 안에 있는 대화는 API로 뺄 수 없어 직접 빼야 합니다)"),
    h("details", { class: "advanced" }, h("summary", { text: "고급 — 영구 삭제" }), h("div", { class: "body" },
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: S.trash.permanent ? true : null, onchange: (e) => set({ permanent: e.target.checked }) }),
        "삭제 후보를 바로 영구 삭제합니다(되돌릴 수 없음)"))));
}

// 삭제후보로 다루는 대화의 표준 제목을 확인·수정한다(삭제후보로 옮길 때도 표준 제목을 갖는다).
function trashItem(d, rows) {
  const row = rows.find((r) => r.conversationId === d.conversationId);
  const title = (row?.newTitle || row?.title || d.title).trim();
  const input = h("input", { class: `title-input${isNormalizedTitle(title) ? "" : " invalid"}`, type: "text", value: title,
    onchange: (e) => patch(d.conversationId, { title: e.target.value.trim() }) });
  return h("div", { class: "item" }, h("div", { class: "t", text: d.title }),
    h("div", { class: "m", text: `${d.project || "프로젝트 없음"} · ${d.why || ""}` }), input);
}

function section(title, count, items, open, note = "", unit = "건") {
  if (!count) return null;
  return h("details", { open: open || null }, h("summary", { text: `${title} (${count}${unit})` }), h("div", { class: "body" }, note ? h("p", { class: "muted small", text: note }) : null, items));
}

export function item(title, meta, controls) {
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
  return h("details", { open: true }, h("summary", { text: `프로젝트별 변화 (${rows.length}개)` }), h("div", { class: "body" },
    h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "프로젝트" }), h("th", { class: "num", text: "이전" }), h("th", { class: "num", text: "이후" }), h("th", { class: "num", text: "변화" }))),
      h("tbody", {}, rows.map((p) => h("tr", {}, h("td", { text: `${p.name}${p.isNew ? " (신규)" : ""}` }), h("td", { class: "num", text: p.before ?? "—" }), h("td", { class: "num", text: p.after ?? "—" }),
        h("td", { class: `num ${p.delta > 0 ? "up" : "down"}`, text: `${p.delta > 0 ? "+" : ""}${p.delta}` })))))));
}

function confirmApply(summary) {
  const dlg = $("confirm"); const form = $("confirm-form"); const deletes = summary.totals.delete;
  const ack = h("input", { type: "checkbox" }); const go = h("button", { class: "btn", value: "go", disabled: deletes > 0 }, "적용 시작");
  ack.addEventListener("change", () => { go.disabled = !ack.checked; });
  fill(form, h("h2", { text: "이 내용으로 적용할까요?" }), h("p", {}, h("strong", { text: summary.headline })), h("p", { class: "small", text: "ChatGPT의 대화가 실제로 바뀝니다." }),
    deletes ? h("label", { class: "check" }, ack, `삭제 ${deletes}건은 되돌릴 수 없음을 확인했습니다`) : null,
    summary.totals.trashed ? h("p", { class: "small", text: `삭제 후보 ${summary.totals.trashed}건은 지우지 않고 「${trashTarget().name}」로 옮깁니다.` }) : null,
    summary.totals.marked ? h("p", { class: "small", text: `삭제 후보 ${summary.totals.marked}건은 이동 없이 표시만 합니다. 직접 지우세요.` }) : null,
    h("p", { class: "muted small", text: "적용은 끝날 때까지 자동으로 이어집니다(429·일시적 오류는 기다렸다가 재개). 이 화면을 닫아도 서버가 계속 진행합니다." }),
    h("div", { class: "row" }, go, h("button", { class: "btn ghost", value: "cancel" }, "취소")));
  dlg.onclose = async () => {
    if (dlg.returnValue !== "go") return;
    try {
      const decisions = effectiveRows().map((r) => r.decision === "delete"
        ? { conversationId: r.conversationId, decision: "delete" }
        : { conversationId: r.conversationId, decision: "keep", newTitle: (r.newTitle || r.title).trim(), projectName: (r.project || "").trim(),
          ...(r.trashed ? { trashed: true } : {}), ...(r.marked ? { marked: true } : {}) });
      const trashedRows = effectiveRows().filter((r) => r.trashed);
      await post("/maintenance/decisions", { decisions, trash: trashedRows.length ? {
        project: trashTarget().name, entries: trashedRows.map((r) => ({ conversationId: r.conversationId, reason: r.why, intendedTarget: null })) } : undefined });
      await post("/maintenance/apply", { confirmDeletes: deletes > 0 });
      S.overrides = new Map(); saveOverrides(); S.forceStep = null;
      await refreshSession();
    } catch (e) { fail(e); }
  };
  dlg.showModal();
}
