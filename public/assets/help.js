// 처음 쓰는 사람을 위한 사용 안내: 이 도구가 하는 일, 5단계, 용어 풀이. 첫 방문에만 펼쳐진다.
import { $, fill, h } from "/assets/dom.js";
import { STEPS } from "/assets/state.js";

const SEEN_KEY = "app_guide_seen";

export const GLOSSARY = [
  ["후보", "이번 확인에서 정리 대상으로 올라온 대화입니다. 새로 생겼거나, 제목·프로젝트가 규칙에 맞지 않는 대화가 해당됩니다."],
  ["기준선", "이 도구가 마지막으로 확인해 적어 둔 ChatGPT 대화 목록(제목·프로젝트)입니다. 새 대화가 무엇인지는 이 기록과 지금 ChatGPT를 비교해서 알아냅니다."],
  ["연결(북마클릿)", "이 도구는 ChatGPT에 직접 로그인하지 않습니다. 여러분이 로그인해 둔 chatgpt.com 탭에서 ‘북마클릿’(도구 모음에 넣어 두는 북마크)을 누르면, 그 탭을 통해서만 ChatGPT와 통신합니다."],
  ["연결 창 / 작업 창", "북마클릿이 여는 ‘🔒 ChatGPT 연결 창’은 연결을 유지하니 닫지 마세요. 정리 작업은 ‘대화 정리 · 작업 창’에서 하며 이 창은 닫아도 됩니다."],
  ["검토 대기", "지워도 될 대화를 바로 지우지 않고 지정한 프로젝트에 모아 두는 안전 장치입니다. ChatGPT에서 직접 확인한 뒤 삭제하거나 되돌립니다."],
  ["표준 제목", "‘핵심 대상·주제 — 실제 작업 또는 결과’ 형식의 제목입니다. 제목만 봐도 무슨 대화인지 알 수 있게 하려는 규칙입니다."],
];

// 각 단계가 무엇이고 누가 하는지. STEPS(state.js)의 순서와 맞춘다.
const STEP_HELP = {
  scan: ["새로 생기거나 바뀐 대화를 ChatGPT에서 읽어 옵니다.", "자동 · 읽기만 합니다"],
  proposal: ["AI 에이전트(Claude Code·Codex 등)에게 각 대화의 새 제목·프로젝트·삭제 여부를 제안받습니다. 이 도구는 AI를 직접 부르지 않습니다.", "AI 대화창에서"],
  review: ["제안 중 마음에 안 드는 것을 고칩니다. 무엇이 바뀌는지 요약을 보고 결정합니다.", "여러분이 결정"],
  apply: ["승인한 제목 변경·삭제·프로젝트 이동만 ChatGPT에 반영합니다.", "버튼 한 번 · 자동으로 이어짐"],
  result: ["무엇이 바뀌었는지, 여러분이 직접 해야 할 일이 남았는지 보여 줍니다.", "확인만 하면 됩니다"],
};

export function stepHint(id) { return STEP_HELP[id]?.[0] || ""; }

export function renderGuide() {
  const box = $("guide");
  let seen = false;
  try { seen = localStorage.getItem(SEEN_KEY) === "1"; } catch {}
  box.open = !seen;
  box.addEventListener("toggle", () => { try { localStorage.setItem(SEEN_KEY, "1"); } catch {} });
  fill(box,
    h("summary", { text: "처음이세요? 이 도구가 하는 일" }),
    h("div", { class: "body" },
      h("p", { text: "ChatGPT 대화를 주제별 프로젝트로 정돈하고, 오래되거나 겹치는 대화를 골라 지우도록 돕습니다. 여러분이 ‘적용’을 누르기 전에는 ChatGPT의 대화가 하나도 바뀌지 않습니다." }),
      h("ol", { class: "guide-steps" }, STEPS.map(([id, label]) => h("li", {},
        h("b", { text: label }), h("span", { text: ` — ${STEP_HELP[id][0]}` }), h("em", { class: "who", text: ` (${STEP_HELP[id][1]})` })))),
      h("p", { class: "muted small", text: "정기적으로(예: 새 대화가 쌓였을 때) 1번부터 5번까지 한 바퀴 돌리면 됩니다. 새 대화가 없으면 1번에서 끝납니다." }),
      h("details", { class: "nested" }, h("summary", { text: "용어 풀이 (후보 · 기준선 · 연결 …)" }),
        h("dl", { class: "glossary" }, GLOSSARY.flatMap(([term, text]) => [h("dt", { text: term }), h("dd", { text })])))));
}
