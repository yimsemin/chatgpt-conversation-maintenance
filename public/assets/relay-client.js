// chatgpt.com 탭(북마클릿 실행기)과 로컬 서버 사이를 잇는 릴레이 클라이언트.
// 이 창은 서버 대기열에서 요청을 꺼내 ChatGPT 탭에 전달하고 결과를 돌려준다. 세션·토큰은 다루지 않는다.
const CHATGPT = "https://chatgpt.com";
const PAGE_TIMEOUT_MS = 60000;

export function startRelay({ api, release, protocolVersion, onState = () => {}, pageTimeoutMs = PAGE_TIMEOUT_MS }) {
  const clientId = crypto.randomUUID();
  let running = false;
  let connected = false;
  let peer = null;
  let needsUpdate = false;
  let ownedElsewhere = false;
  let stopped = false;

  const emit = () => onState({ connected, needsUpdate, ownedElsewhere, hasPeer: Boolean(peer && !peer.closed) });

  function trace(stage, fields) {
    try {
      fetch("/relay/trace", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage, clientId, ...fields }) }).catch(() => {});
    } catch {}
  }

  function deliver(request) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      // 페이지가 응답하지 않아도 연결 루프는 유지한다. 그 요청만 599 로 실패시키고 읽기 op 는 자동 재시도된다.
      const timer = setTimeout(() => {
        window.removeEventListener("message", receive);
        trace("page-timeout", { op: request.op, requestId: request.id, elapsedMs: Date.now() - startedAt });
        resolve({ ok: false, status: 599, data: null, contentType: "",
          bodySnippet: "ChatGPT 페이지 응답 시간 초과 — chatgpt.com 탭을 앞으로 가져오세요" });
      }, pageTimeoutMs);
      function receive(event) {
        if (event.origin !== CHATGPT || event.source !== peer || event.data?.id !== request.id) return;
        if (event.data.type === "chatgpt-relay-v2-ack") {
          trace("page-ack", { op: request.op, requestId: request.id, elapsedMs: Date.now() - startedAt });
          return;
        }
        if (event.data.type !== "chatgpt-relay-v2-result") return;
        clearTimeout(timer);
        window.removeEventListener("message", receive);
        trace("page-result", { op: request.op, requestId: request.id,
          status: Number.isInteger(event.data.result?.status) ? event.data.result.status : null,
          elapsedMs: Date.now() - startedAt });
        resolve(event.data.result);
      }
      window.addEventListener("message", receive);
      trace("post-to-page", { op: request.op, requestId: request.id });
      peer.postMessage({ type: "chatgpt-relay-v2-request", ...request }, CHATGPT);
    });
  }

  async function loop() {
    if (running) return;
    running = true;
    try {
      const claim = await api("/relay/connect", { method: "POST", body: JSON.stringify({ clientId, release, protocolVersion }) });
      if (claim.connected !== true) { ownedElsewhere = true; connected = false; emit(); return; }
      ownedElsewhere = false;
      connected = true;
      emit();
      while (connected && !stopped) {
        const next = await api("/relay/next", { method: "POST", body: JSON.stringify({ clientId }) });
        if (!next.request) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
        if (!peer || peer.closed) throw new Error("ChatGPT 페이지 연결이 끊겼습니다");
        const result = await deliver(next.request);
        try {
          await api("/relay/result", { method: "POST", body: JSON.stringify({ clientId, requestId: next.request.id, result }) });
        } catch (postError) {
          const note = `결과 전달 실패: ${postError?.message || postError}`;
          trace("loop-error", { op: next.request.op, requestId: next.request.id, note });
          await api("/relay/result", { method: "POST", body: JSON.stringify({ clientId, requestId: next.request.id,
            result: { ok: false, status: 599, data: null, contentType: "", bodySnippet: note.slice(0, 200) } }) }).catch(() => {});
        }
      }
    } catch (error) {
      trace("loop-error", { note: error?.message || String(error) });
      connected = false;
      emit();
    } finally { running = false; }
  }

  window.addEventListener("message", (event) => {
    if (stopped || event.origin !== CHATGPT || event.data?.type !== "chatgpt-relay-v2-ready") return;
    if (event.data.release !== release || event.data.protocolVersion !== protocolVersion) {
      trace("version-mismatch", { note: String(event.data.release || "unknown").slice(0, 40) });
      if (peer) return;
      needsUpdate = true;
      connected = false;
      emit();
      return;
    }
    if (peer && peer !== event.source) { trace("peer-ignored", {}); return; }
    if (!peer) peer = event.source;
    needsUpdate = false;
    loop();
  });
  window.addEventListener("pagehide", () => navigator.sendBeacon("/relay/disconnect",
    new Blob([JSON.stringify({ clientId })], { type: "application/json" })));
  if (window.opener) window.opener.postMessage({ type: "chatgpt-relay-probe" }, CHATGPT);
  emit();
  return { clientId, stop() { stopped = true; connected = false; emit(); } };
}
