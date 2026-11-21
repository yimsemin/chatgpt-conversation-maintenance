// 정리 결과 패널.
import { t } from "/assets/language.js";
import { $, fill, h, stamp } from "/assets/dom.js";
import { S } from "/assets/state.js";
import { scopeLabel } from "/assets/panel-scan.js";
import { api, fail } from "/assets/net.js";

// ---------- step 5: result ----------
export async function loadResult() {
  try {
    const data = await api("/maintenance/report");
    if (!data.ready) { fill($("panel"), h("p", { class: "muted", text: t("result.noReport") })); return; }
    const r = data.report; const todo = r.todo;
    const copy = (text) => h("button", { class: "btn ghost", type: "button", onclick: async (e) => { await navigator.clipboard.writeText(text); e.target.textContent = t("result.copied"); } }, t("result.copy.list"));
    fill($("panel"), 
      h("p", { class: "muted small", text: t("result.finished", { scope: scopeLabel(S.session?.run?.scope), when: stamp(r.finishedAt) }) }),
      h("p", { class: "muted small", text: r.note }),
      r.mismatches.length ? h("p", { class: "chip bad", text: t("result.projectsDiffer", { projects: r.mismatches.join(", ") }) }) : h("p", { class: "chip good", text: t("result.projectsMatch") }),
      r.renameOrder?.renamed ? h("p", { class: `chip ${r.renameOrder.preserved ? "good" : "bad"}`, text: r.renameOrder.preserved
        ? t("result.orderPreserved", { count: r.renameOrder.renamed }) : t("result.orderChanged", { count: r.renameOrder.outOfOrder.length }) }) : null,
      r.details?.renames?.length ? h("details", {}, h("summary", { text: t("result.renamed", { count: r.details.renames.length }) }),
        h("ul", { class: "todo" }, r.details.renames.map((m) => h("li", { text: `${m.from} → ${m.to}` })))) : null,
      r.details?.moves?.length ? h("details", {}, h("summary", { text: t("result.moved", { count: r.details.moves.length }) }),
        h("ul", { class: "todo" }, r.details.moves.map((m) => h("li", { text: `${m.title}: ${m.from || t("result.no.project")} → ${m.to}` })))) : null,
      r.details?.trashed?.length ? h("details", {}, h("summary", { text: t("result.trashedCount", { count: r.details.trashed.length }) }),
        h("ul", { class: "todo" }, r.details.trashed.map((m) => h("li", { text: `${m.title}${m.why ? ` — ${m.why}` : ""}` })))) : null,
      h("h3", { text: t("result.nextSteps") }),
      !todo.deleteEmptyProjects.length && !todo.removeFromProject.length && !todo.deleteYourself?.length ? h("p", { class: "muted", text: t("result.none") }) : null,
      todo.deleteYourself?.length ? h("div", {}, h("p", { text: t("result.markedInPlace") }),
        h("ul", { class: "todo" }, todo.deleteYourself.map((m) => h("li", { text: `${m.title}${m.project ? t("result.projectSuffix", { project: m.project }) : ""}` })))) : null,
      todo.deleteEmptyProjects.length ? h("div", {}, h("p", { text: t("result.emptyProjects") }),
        h("ul", { class: "todo" }, todo.deleteEmptyProjects.map((n) => h("li", { text: n }))), copy(todo.deleteEmptyProjects.join("\n"))) : null,
      todo.removeFromProject.length ? h("div", {}, h("p", { text: t("result.manualRemove") }),
        h("ul", { class: "todo" }, todo.removeFromProject.map((m) => h("li", { text: t("result.current.project", { title: m.title, project: m.project }) })))) : null,
      h("h3", { text: t("result.project.changes") }),
      h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: t("result.project") }), h("th", { class: "num", text: t("result.before") }), h("th", { class: "num", text: t("result.after") }), h("th", { class: "num", text: t("result.change") }))),
        h("tbody", {}, r.projects.filter((p) => p.delta !== 0 || p.isNew).map((p) => h("tr", {}, h("td", { text: `${p.name}${p.isNew ? t("result.new") : ""}` }), h("td", { class: "num", text: p.before ?? "—" }), h("td", { class: "num", text: p.actualAfter ?? "—" }),
          h("td", { class: `num ${p.delta > 0 ? "up" : "down"}`, text: `${p.delta > 0 ? "+" : ""}${p.delta}` }))))),
      r.projects.some((p) => (p.delta !== 0 || p.isNew) && p.actualAfter == null) ? h("p", { class: "muted small", text: t("result.notReread") }) : null);
  } catch (e) { fail(e); }
}
