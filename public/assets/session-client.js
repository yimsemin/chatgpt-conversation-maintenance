// 서버 세션 상태 가져오기(폴링)와 현재 단계 판단.
import { S, hooks } from "/assets/state.js";
import { api, fail, wsq } from "/assets/net.js";

// ---------- session polling ----------
export async function refreshSession() {
  try { S.session = await api(`/maintenance/session?${wsq()}`); S.sessionError = null; }
  catch (error) {
    S.session = null; S.sessionError = error;
    // 서버가 응답한 오류(작업 폴더 문제 등)는 한 번만 알리고, 서버 자체가 없을 때는 안내 문구만 보인다.
    if (error?.detail && S.lastErrorShown !== error.message) { S.lastErrorShown = error.message; fail(error); }
  }
  hooks.render();
}

export let pollTimer = null;

export function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = S.session?.job && !S.session.job.done;
  // 연결이 안 된 동안(창을 막 열어 연결 중일 때 포함)에는 1초마다 확인해 연결되는 즉시 화면이 바뀌게 한다.
  const disconnected = S.session && !S.session.relay?.connected;
  pollTimer = setTimeout(async () => { await refreshSession(); schedulePoll(); }, busy ? 1500 : disconnected ? 1000 : 5000);
}

// ---------- rendering ----------
export function currentStep() { return S.view === "trash" ? "trash" : (S.forceStep || S.session?.step || "scan"); }
