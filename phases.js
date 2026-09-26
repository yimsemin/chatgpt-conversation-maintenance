// 현재 실행(포인터)의 단계. 화면·서버·brief가 같은 값을 쓴다.
export const PHASE = Object.freeze({
  AWAITING_PROPOSAL: "awaiting-proposal", // 후보가 있고 제안·검토·결정을 기다린다
  READY_TO_APPLY: "ready-to-apply",       // 검토가 끝난 결정이 있어 적용만 남았다(삭제후보 확정 등)
  COMPLETE: "complete",                    // 적용을 마쳤거나 후보가 없었다
});
