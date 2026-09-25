// 확인 패널과 확인·상태 맞추기·전체 본문 받기 동작, 적용 대기 패널.
import { S, hooks } from "/assets/state.js";
import { $, ago, h } from "/assets/dom.js";
import { fail, post } from "/assets/net.js";
import { refreshSession } from "/assets/session-client.js";

// ---------- step 1: scan ----------
export function scanPanel() {
  const s = S.session; const base = s.baseline;
  const quick = base?.verification === "assume-quiet";
  return h("div", {},
    h("h2", { text: "1. 새 대화 확인" }),
    h("p", { class: "muted", text: "ChatGPT에서 지난 확인 이후 새로 생기거나 바뀐 대화를 찾아 옵니다. ChatGPT는 바꾸지 않고 읽기만 합니다. 대화가 수백 개면 2~3분 걸리며, 끝나면 정리할 대화(후보)가 있는지 알려 드립니다." }),
    s.run?.phase === "complete" && s.run.candidates === 0 && !s.run.hasReport ? h("p", { class: "chip good", text: `새 대화가 없습니다 · ${ago(s.run.updatedAt)} 확인` }) : null,
    !s.relay?.connected ? h("p", { class: "muted small", text: `${s.relay?.hint || ""} 연결되면 위의 ‘새 대화 확인’ 버튼이 켜집니다.` }) : null,
    (base?.stale || quick) ? h("div", { class: "callout" },
      h("strong", { text: "ChatGPT 상태를 한 번 다시 맞추는 것을 권합니다" }), quick
        ? " — 마지막 기록이 ‘최근 수정된 대화만 다시 확인’하는 간단 확인으로 만들어졌습니다. 가끔 전체를 읽어 기록을 바로잡으면 놓친 변화가 없습니다. "
        : " — 마지막 확인이 오래됐습니다. ChatGPT에서 직접 옮기거나 지운 대화가 있다면 기록에 반영합니다. ",
      "읽기만 하며 2~3분 걸립니다. ",
      h("button", { class: "btn ghost", type: "button", disabled: !s.relay?.connected, onclick: startRebaseline }, "ChatGPT 상태 다시 맞추기")) : null,
    s.lastRebaseline ? h("p", { class: "muted small", text: `마지막으로 다시 맞춘 때 ${ago(s.lastRebaseline.at)}: 이동 ${s.lastRebaseline.summary.moved} · 제목 변경 ${s.lastRebaseline.summary.renamed} · 사라진 대화 ${s.lastRebaseline.summary.removed} · 새 대화 ${s.lastRebaseline.summary.newConversations}` }) : null,
    s.parking?.count ? h("div", { class: "callout" },
      h("strong", { text: `검토 대기 ${s.parking.count}건` }), " — 삭제 후보를 ChatGPT의 ",
      h("b", { text: `「${s.parking.project}」` }), " 프로젝트에 모아 두었습니다. 직접 확인한 뒤 삭제하거나 되돌리세요. ",
      h("button", { class: "btn ghost", type: "button", onclick: () => { S.view = "parking"; S.panelKey = ""; hooks.render(); } }, "검토 대기 열기")) : null);
}

// 이미 검토가 끝난 결정(후속 실행 등)을 적용한다. 서버가 도중에 멈춰도 같은 버튼으로 이어진다.
export function applyReadyPanel() {
  return h("div", {}, h("h2", { text: "적용 대기" }),
    h("p", { class: "muted", text: "검토가 끝난 결정이 있습니다. 적용을 시작하면 끝날 때까지 자동으로 이어집니다." }),
    h("div", { class: "row" }, h("button", { class: "btn", type: "button", disabled: !S.session?.relay?.connected, onclick: async () => {
      try { await post("/maintenance/apply", { confirmDeletes: true, quiet: $("quiet").checked }); await refreshSession(); } catch (e) { fail(e); }
    } }, "적용 시작")));
}

export async function startScan() {
  try { S.forceStep = null; await post("/maintenance/scan"); await refreshSession(); } catch (e) { fail(e); }
}

export async function startRebaseline() {
  if (!confirm("ChatGPT의 모든 대화를 읽어(읽기만 함, 2~3분) 직접 옮기거나 지우신 결과를 이 도구의 기록에 반영합니다. 기록에 없던 새 대화는 다음 ‘새 대화 확인’에서 정리 후보가 됩니다. 시작할까요?")) return;
  try { S.forceStep = null; await post("/maintenance/rebaseline"); await refreshSession(); } catch (e) { fail(e); }
}

export async function startCollect() {
  if (!confirm("모든 대화 본문을 받습니다(수백 건, 수 분~수 시간). ChatGPT는 바뀌지 않으며 끊기면 이어받습니다. 시작할까요?")) return;
  try { S.forceStep = null; await post("/maintenance/collect"); await refreshSession(); } catch (e) { fail(e); }
}
