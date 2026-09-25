// 정리 결과 패널.
import { $, fill, h } from "/assets/dom.js";
import { api, fail, wsq } from "/assets/net.js";

// ---------- step 5: result ----------
export async function loadResult() {
  try {
    const data = await api(`/maintenance/report?${wsq()}`);
    if (!data.ready) { fill($("panel"), h("p", { class: "muted", text: "결과 보고서가 없습니다." })); return; }
    const r = data.report; const todo = r.todo;
    const copy = (text) => h("button", { class: "btn ghost", type: "button", onclick: async (e) => { await navigator.clipboard.writeText(text); e.target.textContent = "복사됨"; } }, "목록 복사");
    fill($("panel"), 
      h("h2", { text: "5. 정리 결과" }), h("p", { class: "lead", text: r.headline }),
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
