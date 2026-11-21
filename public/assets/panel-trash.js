// 삭제후보 확인 패널: 삭제후보 프로젝트에 옮겨 둔 대화를 삭제하거나 원래 자리로 되돌린다.
import { t } from "/assets/language.js";
import { isNormalizedTitle } from "/assets/shared/title-rules.js";
import { S } from "/assets/state.js";
import { $, ask, fill, h } from "/assets/dom.js";
import { startTrashSync } from "/assets/panel-scan.js";
import { api, fail, post, toast } from "/assets/net.js";
import { refreshSession } from "/assets/session-client.js";
import { item } from "/assets/panel-review.js";

// ---------- 삭제후보 확인 ----------
export async function loadTrash() {
  try {
    const data = await api("/maintenance/trash");
    const choices = new Map(data.items.map((i) => [i.conversationId, { decision: "keep", project: i.intendedTarget || i.fromProject || "", title: "" }]));
    const projectNames2 = (S.session?.knownProjects?.projects || []).map((p) => p.name).filter((n) => n !== data.project);
    const draw = () => {
      const deletes = [...choices.values()].filter((c) => c.decision === "delete").length;
      fill($("panel"),
        h("p", { class: "muted", text: t("trash.help", { project: data.project }) }),
        !data.items.length ? h("p", { class: "chip good", text: t("trash.empty") }) : null,
        data.items.length ? h("div", { class: "row" }, h("button", { class: "btn ghost", type: "button", disabled: !S.session?.relay?.connected, onclick: startTrashSync }, t("trash.refresh"))) : null,
        h("div", { class: "row" }, h("button", { class: "btn link", type: "button", onclick: () => { for (const c of choices.values()) c.decision = "delete"; draw(); } }, t("trash.delete.all")),
          h("button", { class: "btn link", type: "button", onclick: () => { for (const c of choices.values()) c.decision = "keep"; draw(); } }, t("trash.restore.all"))),
        ...data.items.map((i) => {
          const c = choices.get(i.conversationId);
          const needsTitle = !isNormalizedTitle(i.title) && c.decision === "keep";
          const projSel = h("select", { "aria-label": t("trash.noDestination"), onchange: (e) => { c.project = e.target.value; } }, h("option", { value: "", text: t("trash.noDestination") }), ...projectNames2.map((n) => h("option", { value: n, text: n })));
          projSel.value = c.project;
          const titleInput = needsTitle ? h("input", { class: `title-input${isNormalizedTitle(c.title) ? "" : " invalid"}`, type: "text", value: c.title || "", placeholder: t("trash.newTitleLabel"),
            onchange: (e) => { c.title = e.target.value.trim(); draw(); } }) : null;
          return h("div", { class: "item" }, h("div", { class: "t", text: i.title }),
            h("div", { class: "ctl" }, h("select", { onchange: (e) => { c.decision = e.target.value; draw(); } },
              h("option", { value: "delete", text: t("trash.delete"), selected: c.decision === "delete" ? "" : null }), h("option", { value: "keep", text: t("trash.restore"), selected: c.decision === "keep" ? "" : null })),
              c.decision === "keep" ? projSel : null),
            h("div", { class: "m", text: t("trash.moved.from", { project: i.fromProject || t("trash.no.project"), reason: i.reason || "" }) }), titleInput);
        }),
        h("div", { class: "applybar" }, h("div", {}, h("strong", { text: t("trash.delete.restore", { deleteCount: deletes, restoreCount: data.items.length - deletes }) })),
          h("button", { class: "btn", type: "button", disabled: !data.items.length || !S.session?.relay?.connected, onclick: () => applyTrash(data, choices, deletes) }, t("trash.confirmApply"))));
    };
    draw();
  } catch (e) { fail(e); }
}

async function applyTrash(data, choices, deletes) {
  const bad = data.items.filter((i) => { const c = choices.get(i.conversationId); return c.decision === "keep" && !isNormalizedTitle(i.title) && !isNormalizedTitle(c.title); });
  if (bad.length) { toast(t("trash.restoreTitlesHelp", { count: bad.length })); return; }
  if (deletes && !await ask({ title: t("trash.confirm.deletion"), lines: [t("trash.permanentNote", { count: deletes })], ok: t("trash.confirm") })) return;
  try {
    await post("/maintenance/trash/prepare", { decisions: data.items.map((i) => { const c = choices.get(i.conversationId);
      return { conversationId: i.conversationId, decision: c.decision, projectName: c.project, newTitle: c.decision === "keep" && !isNormalizedTitle(i.title) ? c.title : undefined }; }) });
    await post("/maintenance/apply", { confirmDeletes: deletes > 0 });
    S.view = null; S.forceStep = null; S.panelKey = ""; await refreshSession();
  } catch (e) { fail(e); }
}
