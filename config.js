// 환경 변수로 바꿀 수 있는 값의 단일 목록. 기본값이 실제 사용값이며, 나머지는 자동 시험·개발용이다.
// 여기 없는 환경 변수는 읽지 않는다.
export const CONFIG = Object.freeze({
  // 서버 포트. 시험이 실제 앱과 겹치지 않게 할 때만 바꾼다.
  port: Number(process.env.MAINTENANCE_PORT) || 8523,
  // 읽기 요청 사이의 간격(ms). 설정하면 적응형 간격 조절을 끄고 이 값을 쓴다(시험에서 0).
  requestDelayMs: process.env.MAINTENANCE_REQUEST_DELAY_MS === undefined ? undefined : Number(process.env.MAINTENANCE_REQUEST_DELAY_MS),
  // 429·5xx 재시도 백오프의 시작값(ms).
  relayBackoffMs: Number(process.env.MAINTENANCE_RELAY_BACKOFF_MS) || 5000,
  // 자동 재개 대기의 시작값(초). 시도마다 늘어 최대 30분.
  resumeWaitSeconds: Number(process.env.MAINTENANCE_RESUME_WAIT_SECONDS) || 300,
});
