// 사용 안내: 이 도구가 하는 일과 5단계.
import { $, fill, h } from "/assets/dom.js";
import { STEPS } from "/assets/state.js";

// 각 단계가 무엇이고 누가 하는지. STEPS(state.js)의 순서와 맞춘다.
const STEP_HELP = {
  scan: ["정리할 범위를 고르면 그 범위의 대화를 읽어 옵니다.", "자동 · 읽기만"],
  proposal: ["AI 에이전트가 대화마다 새 제목·프로젝트·삭제 여부를 제안합니다.", "AI 대화창에서"],
  review: ["제안을 보고 마음에 안 드는 것을 고칩니다.", "여러분이 결정"],
  apply: ["승인한 것만 ChatGPT에 반영합니다.", "버튼 한 번"],
  result: ["무엇이 바뀌었는지, 직접 할 일이 있는지 알려 줍니다.", "확인만"],
};

export function stepHint(id) { return STEP_HELP[id]?.[0] || ""; }

export function renderGuide() {
  const box = $("guide");
  fill(box, h("h3", { text: "이 도구가 하는 일" }),
    h("p", { text: "ChatGPT 대화를 프로젝트별로 정리하고 제목을 통일합니다. 필요 없는 대화는 바로 지우지 않고 ‘삭제후보’ 프로젝트로 옮깁니다. ‘적용’을 누르기 전에는 ChatGPT가 바뀌지 않습니다." }),
    h("ol", { class: "guide-steps" }, STEPS.map(([id, label]) => h("li", {},
      h("b", { text: label }), h("span", { text: ` — ${STEP_HELP[id][0]}` }), h("em", { class: "who", text: ` (${STEP_HELP[id][1]})` })))));
}
