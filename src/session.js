import { translator } from "./i18n.js";
// 화면이 "지금 어느 단계이고 다음에 무엇을 하면 되는가"를 판단하는 순수 함수들.
import { PHASE } from "./phases.js";

// 진행 중인 작업이 있으면 그 단계, 없으면 실행 파일 상태로 단계를 정한다.
// resultSuperseded: 결과 보고서보다 나중에 읽기 전용 작업(확인·삭제후보 확인)이 끝났다면 그 결과는 지난 일이다.
export function deriveStep({ activeJobKind = null, phase = "", hasProposal = false, hasReport = false, hasRun = false,
  resultSuperseded = false }) {
  if (activeJobKind === "apply") return "apply";
  if (activeJobKind === "scan") return "scan";
  if (!hasRun) return "scan";
  if (phase === PHASE.READY_TO_APPLY) return "apply";
  if (phase === PHASE.AWAITING_PROPOSAL) return hasProposal ? "review" : "proposal";
  if (phase === PHASE.COMPLETE) return hasReport && !resultSuperseded ? "result" : "scan";
  return "scan";
}

// 연결 상태를 사용자가 바로 이해할 문장으로 바꾼다.
export function describeRelay(status = {}, locale) {
  const t = translator(locale);
  if (!status.connected) {
    return { level: "bad", label: t("relay.disconnected.label"), hint: t("relay.disconnected.hint") };
  }
  if ((status.consecutiveFailures || 0) >= 3) {
    return { level: "warn", label: t("relay.unstable.label"), hint: t("relay.unstable.hint") };
  }
  if (status.lastResultAgoMs != null && status.pending > 0 && status.lastResultAgoMs > 45000) {
    return { level: "warn", label: t("relay.waiting.label"), hint: t("relay.waiting.hint") };
  }
  return { level: "ok", label: t("relay.connected"), hint: "" };
}
