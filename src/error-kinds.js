// 오류의 종류를 문장이 아니라 코드로 구분한다. 화면 문구(번역)를 고쳐도 자동 재개·오류 안내가 달라지지 않게 하려는 것이다.
// 우리 코드가 던지는 오류는 withKind 로 종류를 붙이고, ChatGPT 응답처럼 바깥에서 온 오류만 문장(영어)으로 판별한다.
export const KIND = Object.freeze({
  relayDown: "relay-down",
  relayTimeout: "relay-timeout",
  relayReplaced: "relay-replaced",
  projectNotFound: "project-not-found",
});

export function withKind(error, kind) {
  error.kind = kind;
  return error;
}

// 사용자가 버튼을 다시 누르지 않아도 기다렸다가 이어서 해도 되는 종류.
const TRANSIENT_KINDS = new Set([KIND.relayDown, KIND.relayTimeout, KIND.relayReplaced]);
const TRANSIENT_EXTERNAL = /429|rate.?limit|timed out|HTTP 5\d\d|HTTP 599|disconnected|not connected/i;

export function isTransientFailure(error) {
  if (error?.kind) return TRANSIENT_KINDS.has(error.kind);
  return TRANSIENT_EXTERNAL.test(String(error?.message || error));
}
