// 삭제후보 확인 패널: 삭제후보 프로젝트에 옮겨 둔 대화를 삭제하거나 원래 자리로 되돌린다.
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
    const choices = new Map(data.items.map((i) => [i.conversationId, { decision: "delete", project: i.intendedTarget || i.fromProject || "", title: "" }]));
    const projectNames2 = (S.session?.knownProjects?.projects || []).map((p) => p.name).filter((n) => n !== data.project);
    const draw = () => {
      const deletes = [...choices.values()].filter((c) => c.decision === "delete").length;
      fill($("panel"),
        h("p", { class: "muted", text: `ChatGPT의 「${data.project}」 프로젝트에서 대화를 직접 확인한 뒤, 대화마다 삭제하거나 복원(원래 자리로 이동)하세요. ChatGPT에서 직접 지우거나 옮긴 대화는 ‘ChatGPT에서 다시 확인’으로 목록에서 뺍니다.` }),
        !data.items.length ? h("p", { class: "chip good", text: "삭제후보로 옮겨 둔 대화가 없습니다" }) : null,
        data.items.length ? h("div", { class: "row" }, h("button", { class: "btn ghost", type: "button", disabled: !S.session?.relay?.connected, onclick: startTrashSync }, "ChatGPT에서 다시 확인(읽기 전용)")) : null,
        h("div", { class: "row" }, h("button", { class: "btn ghost", type: "button", onclick: () => { for (const c of choices.values()) c.decision = "delete"; draw(); } }, "전부 삭제"),
          h("button", { class: "btn ghost", type: "button", onclick: () => { for (const c of choices.values()) c.decision = "keep"; draw(); } }, "전부 복원")),
        ...data.items.map((i) => {
          const c = choices.get(i.conversationId);
          const needsTitle = !isNormalizedTitle(i.title) && c.decision === "keep";
          const projSel = h("select", { onchange: (e) => { c.project = e.target.value; } }, h("option", { value: "", text: "프로젝트 없음" }), ...projectNames2.map((n) => h("option", { value: n, text: n })));
          projSel.value = c.project;
          const titleInput = needsTitle ? h("input", { class: `title-input${isNormalizedTitle(c.title) ? "" : " invalid"}`, type: "text", value: c.title || "", placeholder: "새 제목 (주제 — 작업/결과)",
            onchange: (e) => { c.title = e.target.value.trim(); draw(); } }) : null;
          return h("div", { class: "item" }, h("div", { class: "t", text: i.title }),
            h("div", { class: "ctl" }, h("select", { onchange: (e) => { c.decision = e.target.value; draw(); } },
              h("option", { value: "delete", text: "삭제", selected: c.decision === "delete" ? "" : null }), h("option", { value: "keep", text: "복원", selected: c.decision === "keep" ? "" : null })),
              c.decision === "keep" ? projSel : null),
            h("div", { class: "m", text: `${i.fromProject || "프로젝트 없음"}에서 옮김 · ${i.reason || ""}` }), titleInput);
        }),
        h("div", { class: "applybar" }, h("div", {}, h("strong", { text: `삭제 ${deletes}건 · 복원 ${data.items.length - deletes}건` })),
          h("button", { class: "btn", type: "button", disabled: !data.items.length || !S.session?.relay?.connected, onclick: () => applyTrash(data, choices, deletes) }, "확정하고 적용")));
    };
    draw();
  } catch (e) { fail(e); }
}

async function applyTrash(data, choices, deletes) {
  const bad = data.items.filter((i) => { const c = choices.get(i.conversationId); return c.decision === "keep" && !isNormalizedTitle(i.title) && !isNormalizedTitle(c.title); });
  if (bad.length) { toast(`복원할 대화 ${bad.length}건의 제목을 표준 형식(주제 — 작업/결과)으로 적어 주세요.`); return; }
  if (deletes && !await ask({ title: "삭제를 확정할까요?", lines: [`삭제 ${deletes}건은 되돌릴 수 없습니다.`], ok: "확정" })) return;
  try {
    await post("/maintenance/trash/prepare", { decisions: data.items.map((i) => { const c = choices.get(i.conversationId);
      return { conversationId: i.conversationId, decision: c.decision, projectName: c.project, newTitle: c.decision === "keep" && !isNormalizedTitle(i.title) ? c.title : undefined }; }) });
    await post("/maintenance/apply", { confirmDeletes: deletes > 0 });
    S.view = null; S.forceStep = null; S.panelKey = ""; await refreshSession();
  } catch (e) { fail(e); }
}
