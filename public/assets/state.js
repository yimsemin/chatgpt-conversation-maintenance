// 화면 전체가 공유하는 상태 하나와 화면 갱신 진입점.


export const STEPS = [["scan", "확인"], ["proposal", "제안"], ["review", "검토"], ["apply", "적용"], ["result", "결과"]];

export const S = {
  session: null, catalog: null, proposal: null, overrides: new Map(),
  forceStep: null, panelKey: "", live: [], relayLocal: { connected: false },
  sessionError: null, lastErrorShown: null, lastScanEmpty: null, view: null, dismissed: new Set(),
  scope: { kind: "unassigned", projectNames: [], days: 7, window: 14 },
  // 삭제 후보 처리 방식(설정 파일의 기본값 위에 사용자가 화면에서 고른 값): mode auto|fixed|none, name, permanent(영구 삭제)
  trash: { mode: "auto", name: "삭제후보", permanent: false }, trashDefault: "삭제후보",
};

// 화면 갱신 진입점. app.js 가 시작할 때 render 를 등록한다(패널이 app.js 를 거꾸로 불러오지 않게).
export const hooks = { render() {} };
