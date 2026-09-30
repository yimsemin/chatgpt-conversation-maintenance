// 정리 결과 패널.
import { $, fill, h } from "/assets/dom.js";
import { api, fail } from "/assets/net.js";

// ---------- step 5: result ----------
export async function loadResult() {
  try {
    const data = await api("/maintenance/report");
    if (!data.ready) { fill($("panel"), h("p", { class: "muted", text: "결과 보고서가 없습니다." })); return; }
    const r = data.report; const todo = r.todo;
    const copy = (text) => h("button", { class: "btn ghost", type: "button", onclick: async (e) => { await navigator.clipboard.writeText(text); e.target.textContent = "복사됨"; } }, "목록 복사");
    fill($("panel"), 
      h("p", { class: "muted small", text: r.note }),
      r.mismatches.length ? h("p", { class: "chip bad", text: `예상과 다른 프로젝트: ${r.mismatches.join(", ")}` }) : h("p", { class: "chip good", text: "모든 프로젝트가 예상과 일치합니다" }),
      r.renameOrder?.renamed ? h("p", { class: `chip ${r.renameOrder.preserved ? "good" : "bad"}`, text: r.renameOrder.preserved
        ? `제목을 바꾼 ${r.renameOrder.renamed}건의 목록 순서가 원래 상대 순서대로입니다` : `제목을 바꾼 대화 ${r.renameOrder.outOfOrder.length}건의 순서가 달라졌습니다` }) : null,
      r.details?.renames?.length ? h("details", {}, h("summary", { text: `바뀐 제목 ${r.details.renames.length}건` }),
        h("ul", { class: "todo" }, r.details.renames.map((m) => h("li", { text: `${m.from} → ${m.to}` })))) : null,
      r.details?.moves?.length ? h("details", {}, h("summary", { text: `옮긴 대화 ${r.details.moves.length}건` }),
        h("ul", { class: "todo" }, r.details.moves.map((m) => h("li", { text: `${m.title}: ${m.from || "프로젝트 없음"} → ${m.to}` })))) : null,
      r.details?.trashed?.length ? h("details", {}, h("summary", { text: `삭제후보로 보낸 대화 ${r.details.trashed.length}건` }),
        h("ul", { class: "todo" }, r.details.trashed.map((m) => h("li", { text: `${m.title}${m.why ? ` — ${m.why}` : ""}` })))) : null,
      h("h3", { text: "직접 하실 일" }),
      !todo.deleteEmptyProjects.length && !todo.removeFromProject.length && !todo.deleteYourself?.length ? h("p", { class: "muted", text: "없습니다." }) : null,
      todo.deleteYourself?.length ? h("div", {}, h("p", { text: "삭제후보로 표시만 한 대화 — ChatGPT에서 직접 지우세요:" }),
        h("ul", { class: "todo" }, todo.deleteYourself.map((m) => h("li", { text: `${m.title}${m.project ? ` — 프로젝트 ${m.project}` : ""}` })))) : null,
      todo.deleteEmptyProjects.length ? h("div", {}, h("p", { text: "비어 있는 프로젝트 — 필요 없으면 ChatGPT에서 삭제하세요:" }),
        h("ul", { class: "todo" }, todo.deleteEmptyProjects.map((n) => h("li", { text: n }))), copy(todo.deleteEmptyProjects.join("\n"))) : null,
      todo.removeFromProject.length ? h("div", {}, h("p", { text: "프로젝트에서 직접 빼야 하는 대화(앱은 뺄 수 없음):" }),
        h("ul", { class: "todo" }, todo.removeFromProject.map((m) => h("li", { text: `${m.title} — 현재 ${m.project}` })))) : null,
      h("h3", { text: "프로젝트별 변화" }),
      h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "프로젝트" }), h("th", { class: "num", text: "이전" }), h("th", { class: "num", text: "이후" }), h("th", { class: "num", text: "변화" }))),
        h("tbody", {}, r.projects.filter((p) => p.delta !== 0 || p.isNew).map((p) => h("tr", {}, h("td", { text: `${p.name}${p.isNew ? " (신규)" : ""}` }), h("td", { class: "num", text: p.before ?? "—" }), h("td", { class: "num", text: p.actualAfter ?? "—" }),
          h("td", { class: `num ${p.delta > 0 ? "up" : "down"}`, text: `${p.delta > 0 ? "+" : ""}${p.delta}` }))))));
  } catch (e) { fail(e); }
}
