// 화면이 "지금 어느 단계이고 다음에 무엇을 하면 되는가"를 판단하는 순수 함수들.

export const STEPS = ["scan", "proposal", "review", "apply", "result"];

// 진행 중인 작업이 있으면 그 단계, 없으면 실행 파일 상태로 단계를 정한다.
export function deriveStep({ activeJobKind = null, phase = "", hasProposal = false, hasReport = false, hasRun = false }) {
  if (activeJobKind === "apply") return "apply";
  if (activeJobKind === "scan") return "scan";
  if (!hasRun) return "scan";
  if (phase === "ready-to-apply") return "apply";
  if (phase === "awaiting-proposal") return hasProposal ? "review" : "proposal";
  if (phase === "complete") return hasReport ? "result" : "scan";
  return "scan";
}

// 연결 상태를 사용자가 바로 이해할 문장으로 바꾼다.
export function describeRelay(status = {}) {
  if (!status.connected) {
    return { level: "bad", label: "ChatGPT 연결 끊김",
      hint: "chatgpt.com 탭에서 북마클릿(ChatGPT → 유지관리)을 실행하세요." };
  }
  if ((status.consecutiveFailures || 0) >= 3) {
    return { level: "warn", label: "연결됨 · 응답 불안정",
      hint: "chatgpt.com 탭을 앞으로 가져오고 잠시 기다리세요. 백그라운드 탭은 응답이 느려집니다." };
  }
  if (status.lastResultAgoMs != null && status.pending > 0 && status.lastResultAgoMs > 45000) {
    return { level: "warn", label: "연결됨 · 응답 대기 중",
      hint: "ChatGPT 페이지가 응답하지 않고 있습니다. chatgpt.com 탭을 앞으로 가져오세요." };
  }
  return { level: "ok", label: "ChatGPT 연결됨", hint: "" };
}

// 기준선 신선도. 오래되면 확인을 권한다.
export function describeBaseline({ generatedAt = null, verification = null }, nowMs = Date.now()) {
  if (!generatedAt) return { days: null, stale: true, verification };
  const days = Math.floor((nowMs - Date.parse(generatedAt)) / 86400000);
  return { days, stale: days >= 7, verification };
}
