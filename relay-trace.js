// 릴레이 경계 진단용 링 버퍼.
//
// Phase 6의 실패는 "로컬 대기열 → 유지관리 창 → ChatGPT 페이지 → fetch → 결과 →
// 워크플로 복귀"의 어느 경계에서 멈추는지 구분되지 않아 원인을 못 좁혔다. 이 모듈은
// 그 경계마다 op·요청 ID·단계·HTTP 상태·경과 시간만 남긴다.
//
// 남기지 않는 것: 토큰, 쿠키, 세션 응답, 대화 본문, 응답 본문, URL의 임의 입력.

const MAX_EVENTS = 400;
const STAGES = new Set([
  "connect", "connect-replaced", "connect-refused", "disconnect",
  "op-rejected", "enqueue", "dequeue", "post-to-page", "page-ack", "page-result",
  "result-accepted", "result-rejected", "result-late",
  "broker-timeout", "page-timeout", "cancel",
  "peer-ignored", "version-mismatch", "loop-error",
]);

function shortId(value) {
  return typeof value === "string" && value ? value.slice(0, 8) : null;
}

export function createRelayTrace({ now = () => Date.now(), max = MAX_EVENTS } = {}) {
  const events = [];
  let seq = 0;
  const startedAt = now();

  function record(stage, fields = {}) {
    if (!STAGES.has(stage)) return null;
    const event = {
      seq: ++seq,
      atMs: now() - startedAt,
      stage,
      op: typeof fields.op === "string" ? fields.op : null,
      requestId: shortId(fields.requestId),
      clientId: shortId(fields.clientId),
      status: Number.isInteger(fields.status) ? fields.status : null,
      elapsedMs: Number.isInteger(fields.elapsedMs) ? fields.elapsedMs : null,
      note: typeof fields.note === "string" ? fields.note.slice(0, 120) : null,
    };
    events.push(event);
    if (events.length > max) events.splice(0, events.length - max);
    return event;
  }

  return {
    record,
    list: () => events.slice(),
    clear: () => { events.length = 0; },
  };
}

export const relayTrace = createRelayTrace();
