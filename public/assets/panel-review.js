// 바뀌는 내용 검토 패널: 요약, 예외 목록, 수정, 적용 확인.
import { buildReviewSummary, rowsFromProposal } from "/assets/shared/summary.js";
import { isNormalizedTitle } from "/assets/shared/title-rules.js";
import { S } from "/assets/state.js";
import { $, fill, h, meta } from "/assets/dom.js";
import { api, fail, post, wsq } from "/assets/net.js";
import { refreshSession } from "/assets/session-client.js";

// ---------- step 3: review ----------
export async function loadReview() {
  try {
    const [proposal, catalog] = await Promise.all([api(`/maintenance/proposal?${wsq()}`), api(`/maintenance/catalog?${wsq()}`)]);
    S.proposal = proposal; S.catalog = catalog;
    if (!proposal.ready) { fill($("panel"), h("p", { text: "분류 제안이 아직 없습니다." })); return; }
    loadOverrides();
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
  const name = h("input", { type: "text", value: S.parkingProject || "검토 대기", style: "width:140px" });
  const commit = () => {
    S.parkingProject = check.checked ? name.value.trim() : "";
    try { localStorage.setItem("app_parking_project", S.parkingProject); } catch {}
    drawReview();
  };
  check.addEventListener("change", commit); name.addEventListener("change", () => { if (check.checked) commit(); });
  return h("label", { class: "check" }, check, "삭제 후보를 곧바로 지우지 않고 먼저", name, "프로젝트에 임시 보관합니다(ChatGPT에서 직접 확인한 뒤 삭제 확정)");
}

export function section(title, count, items, open, note = "") {
  if (!count) return null;
  return h("details", { open: open || null }, h("summary", { text: `${title} (${count})` }), h("div", { class: "body" }, note ? h("p", { class: "muted small", text: note }) : null, items));
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
  return h("details", { open: true }, h("summary", { text: `프로젝트별 변화 (${rows.length})` }), h("div", { class: "body" },
    h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "프로젝트" }), h("th", { class: "num", text: "이전" }), h("th", { class: "num", text: "이후" }), h("th", { class: "num", text: "변화" }))),
      h("tbody", {}, rows.map((p) => h("tr", {}, h("td", { text: `${p.name}${p.isNew ? " (신규)" : ""}` }), h("td", { class: "num", text: p.before }), h("td", { class: "num", text: p.after }),
        h("td", { class: `num ${p.delta > 0 ? "up" : "down"}`, text: `${p.delta > 0 ? "+" : ""}${p.delta}` })))))));
}

function confirmApply(summary) {
  const dlg = $("confirm"); const form = $("confirm-form"); const deletes = summary.totals.delete;
  const ack = h("input", { type: "checkbox" }); const go = h("button", { class: "btn", value: "go", disabled: deletes > 0 }, "적용 시작");
  ack.addEventListener("change", () => { go.disabled = !ack.checked; });
  fill(form, h("h2", { text: "이 내용으로 적용할까요?" }), h("p", {}, h("strong", { text: summary.headline })), h("p", { class: "small", text: "ChatGPT의 대화가 실제로 바뀝니다." }),
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
      S.overrides = new Map(); saveOverrides(); S.forceStep = null;
      await refreshSession();
    } catch (e) { fail(e); }
  };
  dlg.showModal();
}
