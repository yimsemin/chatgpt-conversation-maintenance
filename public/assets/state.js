// 화면 전체가 공유하는 상태 하나와 화면 갱신 진입점.


export const STEPS = [["scan", "확인"], ["proposal", "제안"], ["review", "검토"], ["apply", "적용"], ["result", "결과"]];

export const S = {
  workspace: "", session: null, catalog: null, proposal: null, overrides: new Map(),
  forceStep: null, panelKey: "", live: [], quiet: true, relayLocal: { connected: false },
  sessionError: null, lastErrorShown: null, lastScanEmpty: null, view: null, parking: null, dismissed: new Set(),
  parkingProject: (() => { try { return localStorage.getItem("app_parking_project") || ""; } catch { return ""; } })(),
};

// 화면 갱신 진입점. app.js 가 시작할 때 render 를 등록한다(패널이 app.js 를 거꾸로 불러오지 않게).
export const hooks = { render() {} };
