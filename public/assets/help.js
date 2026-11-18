// 사용 안내: 이 도구가 하는 일과 5단계.
import { t } from "/assets/language.js";
import { $, fill, h } from "/assets/dom.js";
import { STEPS } from "/assets/state.js";

// 각 단계가 무엇이고 누가 하는지. STEPS(state.js)의 순서와 맞춘다.
const STEP_HELP = {
  scan: [t("help.choose.a.scope.the.app.collects.conversations"), t("help.automatic.read.only")],
  proposal: [t("help.an.ai.agent.suggests.a.title.project"), t("help.in.an.ai.chat")],
  review: [t("help.review.the.proposal.and.make.any.edits"), t("help.your.decision")],
  apply: [t("help.the.app.applies.your.approved.changes.in"), t("help.one.button")],
  result: [t("help.see.what.changed.and.what.still.needs"), t("help.review.results")],
};

export function stepHint(id) { return STEP_HELP[id]?.[0] || ""; }

export function renderGuide() {
  const box = $("guide");
  fill(box, h("h3", { text: t("help.what.this.app.does") }),
    h("p", { text: t("help.organize.chatgpt.conversations.into.projects.and.standardize") }),
    h("ol", { class: "guide-steps" }, STEPS.map(([id, label]) => h("li", {},
      h("b", { text: label }), h("span", { text: ` — ${STEP_HELP[id][0]}` }), h("em", { class: "who", text: ` (${STEP_HELP[id][1]})` })))));
}
