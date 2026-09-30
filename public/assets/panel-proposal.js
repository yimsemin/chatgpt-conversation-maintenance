// 분류 제안을 받는 패널.
import { S } from "/assets/state.js";
import { h } from "/assets/dom.js";
import { fail, post } from "/assets/net.js";
import { refreshSession } from "/assets/session-client.js";
import { skippedCallout } from "/assets/panel-scan.js";

// ---------- step 2: proposal ----------
export function proposalPanel() {
  const run = S.session.run;
  const prompt = "이 저장소에서 `npm run brief`를 실행하고, 안내대로 분류 제안(proposal.json)을 만들어 검증해줘.";
  const paste = h("textarea", { rows: "6", placeholder: "분류 결과 JSON 붙여넣기" });
  return h("div", {},
    h("p", { class: "muted", text: "이 저장소를 연 AI 에이전트(Claude Code·Codex 등)에게 아래 문장을 그대로 전달하세요. 제안이 만들어지면 화면이 저절로 다음 단계로 넘어갑니다." }),
    run?.standardTitlesExcluded ? h("p", { class: "muted small", text: `표준 제목이거나 제목을 그대로 두기로 한 ${run.standardTitlesExcluded}건은 받지 않고 후보에서 뺐습니다.` }) : null,
    run?.skipped?.length ? skippedCallout(run.skipped) : null,
    h("div", { class: "callout", text: prompt }),
    h("div", { class: "row" }, h("button", { class: "btn", type: "button", onclick: async (e) => { await navigator.clipboard.writeText(prompt); e.target.textContent = "복사됨"; } }, "문장 복사")),
    h("details", {}, h("summary", { text: "에이전트 없이 결과 JSON을 붙여넣기" }),
      h("div", { class: "body" }, paste, h("div", { class: "row" }, h("button", { class: "btn ghost", type: "button", onclick: async () => {
        try { await post("/maintenance/proposal", { proposalJson: paste.value }); await refreshSession(); } catch (e) { fail(e); }
      } }, "검증하고 불러오기")))));
}
