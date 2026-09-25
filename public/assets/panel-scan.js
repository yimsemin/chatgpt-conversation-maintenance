// 확인(스캔) 패널과 확인·검증·전체 스캔 동작, 적용 대기 패널.
import { S, hooks } from "/assets/state.js";
import { $, ago, h } from "/assets/dom.js";
import { fail, post } from "/assets/net.js";
import { refreshSession } from "/assets/session-client.js";

// ---------- step 1: scan ----------
export function scanPanel() {
  const s = S.session; const base = s.baseline;
  return h("div", {},
    h("h2", { text: "1. 새 대화 확인" }),
    h("p", { class: "muted", text: "지난 확인 이후 새로 생기거나 바뀐 대화를 찾습니다. ChatGPT는 바꾸지 않습니다." }),
    s.run?.phase === "complete" && s.run.candidates === 0 && !s.run.hasReport ? h("p", { class: "chip good", text: `새 대화가 없습니다 · ${ago(s.run.updatedAt)} 확인` }) : null,
    base ? h("div", { class: "chips" }, h("span", { class: "chip", text: `대화 ${base.counts?.conversations ?? "?"}개` }),
      h("span", { class: "chip", text: `프로젝트 ${base.counts?.projects ?? "?"}개` }),
      h("span", { class: `chip ${base.stale ? "warn" : ""}`, text: `${ago(base.generatedAt)} 확인` }),
      base.verification === "assume-quiet" ? h("span", { class: "chip warn", text: "빠른 검증 기준선(가끔 확정 권장)" }) : null,
      h("span", { class: `chip ${s.fastScan?.nextScanIncremental ? "good" : ""}`, text: s.fastScan?.nextScanIncremental ? "증분 스캔(빠름)" : "전체 스캔" })) : null,
    !s.relay?.connected ? h("p", { class: "muted small", text: `${s.relay?.hint || ""} 연결되면 위의 ‘새 대화 확인’ 버튼이 켜집니다.` }) : null,
    (base?.stale || base?.verification === "assume-quiet") ? h("div", { class: "copybox", style: "margin-top:14px" },
      h("strong", { text: "기준선 확정을 권합니다" }), " — ChatGPT에서 직접 정리하셨거나 기준선이 빠른 검증으로만 확정된 상태입니다. 전체 스캔(읽기 전용, 수 분)으로 현재 계정을 기준선에 반영하세요. ",
      h("button", { class: "btn ghost", type: "button", disabled: !s.relay?.connected, onclick: startRebaseline }, "기준선 확정")) : null,
    s.lastRebaseline ? h("p", { class: "muted small", text: `마지막 기준선 확정 ${ago(s.lastRebaseline.at)}: 이동 ${s.lastRebaseline.summary.moved} · 제목 변경 ${s.lastRebaseline.summary.renamed} · 사라진 대화 ${s.lastRebaseline.summary.removed} · 새 대화 ${s.lastRebaseline.summary.newConversations}` }) : null,
    s.parking?.count ? h("div", { class: "copybox", style: "margin-top:14px" },
      h("strong", { text: `검토 대기 ${s.parking.count}건` }), " — 삭제 후보를 ChatGPT의 ",
      h("b", { text: `「${s.parking.project}」` }), " 프로젝트에 모아 두었습니다. 직접 확인한 뒤 확정하세요. ",
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

export async function startProbe() {
  if (!confirm("빠른 목록 방식이 전체 방식과 같은 결과인지 확인합니다(읽기 전용, 수 분). 통과하면 다음 확인부터 증분 스캔을 씁니다. 시작할까요?")) return;
  try { S.forceStep = null; await post("/maintenance/probe"); await refreshSession(); } catch (e) { fail(e); }
}

export async function startRebaseline() {
  if (!confirm("ChatGPT의 모든 대화를 읽어(읽기 전용, 수 분) 직접 정리하신 결과를 기준선에 반영합니다. 기준선에 없던 새 대화는 다음 확인에서 후보로 남습니다. 시작할까요?")) return;
  try { S.forceStep = null; await post("/maintenance/rebaseline"); await refreshSession(); } catch (e) { fail(e); }
}

export async function startFullScan() {
  try { S.forceStep = null; await post("/maintenance/scan", { full: true }); await refreshSession(); } catch (e) { fail(e); }
}

export async function startCollect() {
  if (!confirm("모든 대화 본문을 받습니다(수백 건, 수 분~수 시간). ChatGPT는 바뀌지 않으며 끊기면 이어받습니다. 시작할까요?")) return;
  try { S.forceStep = null; await post("/maintenance/collect"); await refreshSession(); } catch (e) { fail(e); }
}
