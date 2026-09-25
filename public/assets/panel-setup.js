// 처음 시작하기(연결 + 기준선) 패널.
import { S } from "/assets/state.js";
import { h } from "/assets/dom.js";
import { fail, post } from "/assets/net.js";
import { refreshSession } from "/assets/session-client.js";

// ---------- 처음 시작 ----------
export function setupPanel() {
  const relay = S.session.relay; const connected = Boolean(relay?.connected);
  const check = (done) => h("span", { class: `chip ${done ? "good" : "warn"}`, text: done ? "완료" : "할 일" });
  const start = async (mode) => {
    const msg = mode === "accept"
      ? "지금 ChatGPT에 있는 모든 대화를 읽어 기준선으로 삼습니다(읽기 전용). 이후에는 새로 생기는 대화만 정리합니다. 시작할까요?"
      : "모든 대화를 처음부터 정리 대상으로 삼습니다. 다음 ‘새 대화 확인’에서 전체 대화 본문을 받으므로 오래 걸립니다. 시작할까요?";
    if (!confirm(msg)) return;
    try { await post("/maintenance/baseline", { mode }); await refreshSession(); } catch (e) { fail(e); }
  };
  return h("div", {}, h("h2", { text: "처음 시작하기" }),
    h("p", { class: "muted", text: "두 가지만 하면 됩니다. ChatGPT는 이 단계에서 바뀌지 않습니다." }),
    h("div", { class: "callout" }, h("div", { class: "row" }, h("strong", { text: "1. ChatGPT 연결" }), check(connected)),
      connected ? h("span", { text: "연결되어 있습니다." }) : h("div", {}, "먼저 북마클릿을 한 번 설치합니다. 그다음 로그인한 chatgpt.com 탭에서 그 북마크를 누르면 이 화면이 ‘연결됨’으로 바뀝니다. 작업하는 동안 그 탭은 앞에 열어 두세요.",
        h("div", { class: "row" }, h("a", { class: "btn", href: "/auth/bookmarklet", target: "_blank", rel: "noopener" }, "북마클릿 설치 안내 열기")))),
    h("div", { class: "callout" }, h("div", { class: "row" }, h("strong", { text: "2. 기준선 만들기" }), check(false)),
      "정리의 출발점을 정합니다. 어느 쪽이든 시작 전에는 ChatGPT를 바꾸지 않습니다.",
      h("div", { class: "row" },
        h("button", { class: "btn", type: "button", disabled: !connected, onclick: () => start("accept") }, "지금 대화는 그대로 두고 새 대화만 정리 (권장)"),
        h("button", { class: "btn ghost", type: "button", disabled: !connected, onclick: () => start("empty") }, "모든 대화를 처음부터 정리")),
      !connected ? h("p", { class: "muted small", text: "1번을 마치면 버튼이 켜집니다." }) : null));
}
