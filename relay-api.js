import { randomUUID } from "node:crypto";
import { assert } from "./assert.js";
import { validateRemoteOperation, validateRemoteResult } from "./remote-ops.js";
import { createRelayTrace } from "./relay-trace.js";

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
// 599 는 페이지 쪽 fetch 예외·결과 전달 실패를 뜻하는 가짜 상태다. 읽기 op 에서만 재시도한다.
const READ_OPS = new Set(["getConversation", "listConversations", "listProjects", "listProjectConversations"]);

// timeoutMs: 한 요청의 왕복 제한. 대화 본문은 수 MB 라 목록 조회보다 오래 걸린다.
// livenessMs: 유지관리 창이 살아있다고 볼 기간(백그라운드 탭은 타이머가 분 단위로 늦어지므로 넉넉히 둔다). 둘을 묶으면 왕복 제한을 늘릴 때
// "페이지가 연결되지 않았습니다" 판정이 같이 둔해진다.
export function createRelayBroker({ timeoutMs = 90000, livenessMs = 120000, stuckMs = 20000,
  now = () => Date.now(), trace = createRelayTrace({ now }) } = {}) {
  const queue = [];
  const pending = new Map();
  let clientId = null;
  let lastSeenAt = 0;
  const health = { lastResultAt: 0, lastStatus: null, consecutiveFailures: 0, timeouts: 0 };

  function connect(id) {
    assert(typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id), "Relay client ID is invalid");
    // 먼저 연결한 창이 릴레이를 소유한다. 새로 온 창이 빼앗게 하면, 밀려난 창이 페이지의
    // 500ms 하트비트로 루프를 다시 시작해 서로를 무한히 밀어내는 교착에 빠진다(2026-09-12 실측).
    // 소유 창이 조용해져 생존 기간이 지난 뒤에만 인수를 허용한다.
    // 소유 창이 아직 살아 있어 보여도(하트비트가 늦게 오는 백그라운드 창) 요청 하나가 stuckMs 넘게 꺼내지지 않았다면
    // 그 창은 일을 하지 못하는 상태이므로, 지금 막 연결을 요청한 창에 넘긴다. 그렇지 않으면 사용자는 90초를 기다려 실패만 본다.
    const ownerStuck = queue.some((entry) => pending.has(entry.id) && now() - entry.enqueuedAt > stuckMs);
    if (clientId && clientId !== id && now() - lastSeenAt <= livenessMs && !ownerStuck) {
      trace.record("connect-refused", { clientId, note: `owned; ${id.slice(0, 8)} refused` });
      return { connected: false, reason: "relay-owned" };
    }
    if (clientId && clientId !== id) {
      trace.record("connect-replaced", { clientId, note: `${ownerStuck ? "stuck" : "stale"}; taken over by ${id.slice(0, 8)}` });
      for (const requestId of [...pending.keys()]) cancel(requestId, "Relay client was replaced", { retryable: true });
      queue.length = 0;
    }
    clientId = id;
    lastSeenAt = now();
    trace.record("connect", { clientId: id });
    return { connected: true };
  }
  function request(operation, signal) {
    // 검증 실패는 다시 시도해도 절대 통과하지 않는다. retryable 표시를 빼먹으면
    // 지수 백오프에 들어가 HTTP 상태 없는 [retry] 가 반복된다(r9 에서 실제로 발생).
    let validated;
    try {
      validated = validateRemoteOperation(operation);
    } catch (error) {
      trace.record("op-rejected", { op: operation?.op, note: error?.message });
      error.retryable = false;
      throw error;
    }
    assert(clientId && now() - lastSeenAt <= livenessMs, "ChatGPT relay page is not connected");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const enqueuedAt = now();
      const timer = setTimeout(() => {
        pending.delete(id);
        health.timeouts += 1;
        health.consecutiveFailures += 1;
        trace.record("broker-timeout", { op: validated.op, requestId: id, elapsedMs: now() - enqueuedAt });
        const error = new Error(`ChatGPT page relay timed out: ${validated.op}`);
        error.retryable = false;
        reject(error);
      }, timeoutMs);
      const entry = { id, operation: validated, resolve, reject, timer, enqueuedAt };
      pending.set(id, entry);
      queue.push(entry);
      trace.record("enqueue", { op: validated.op, requestId: id });
      if (signal) signal.addEventListener("abort", () => cancel(id, "Remote operation was cancelled"), { once: true });
    });
  }
  function next(id) {
    assert(id === clientId, "Relay client is not connected");
    lastSeenAt = now();
    while (queue.length) {
      const entry = queue.shift();
      if (pending.has(entry.id)) {
        trace.record("dequeue", { op: entry.operation.op, requestId: entry.id,
          elapsedMs: now() - entry.enqueuedAt });
        return { request: { id: entry.id, ...entry.operation } };
      }
    }
    return { request: null };
  }
  function complete(id, requestId, result) {
    assert(id === clientId, "Relay client is not connected");
    lastSeenAt = now();
    const entry = pending.get(requestId);
    // 이미 시간 초과되거나 취소된 요청의 늦은 결과는 오류로 만들지 않는다. 여기서 throw 하면
    // 유지관리 창의 릴레이 루프가 400 을 받고 연결을 끊어 실패가 연쇄된다.
    if (!entry) {
      trace.record("result-late", { requestId });
      return { accepted: false, reason: "not-pending" };
    }
    let validated;
    try {
      validated = validateRemoteResult(result, entry.operation);
    } catch (error) {
      clearTimeout(entry.timer);
      pending.delete(requestId);
      trace.record("result-rejected", { op: entry.operation.op, requestId,
        elapsedMs: now() - entry.enqueuedAt, note: error?.message });
      error.retryable = false;
      entry.reject(error);
      return { accepted: false, reason: "invalid-result" };
    }
    clearTimeout(entry.timer);
    pending.delete(requestId);
    trace.record("result-accepted", { op: entry.operation.op, requestId,
      status: validated.status, elapsedMs: now() - entry.enqueuedAt });
    health.lastResultAt = now();
    health.lastStatus = validated.status;
    health.consecutiveFailures = validated.status >= 500 || validated.status === 429 ? health.consecutiveFailures + 1 : 0;
    entry.resolve(validated);
    return { accepted: true };
  }
  // retryable: 연결(정리 창)이 바뀌거나 끊겨서 취소된 요청은 새 연결로 다시 보낼 수 있다. 사용자 취소는 다시 보내지 않는다.
  function cancel(requestId, message = "Remote operation was cancelled", { retryable = false } = {}) {
    const entry = pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pending.delete(requestId);
    trace.record("cancel", { op: entry.operation.op, requestId, note: message });
    const error = new Error(message);
    error.retryable = retryable;
    entry.reject(error);
    return true;
  }
  function disconnect(id) {
    if (id !== clientId) return { disconnected: false };
    trace.record("disconnect", { clientId: id });
    clientId = null;
    for (const requestId of [...pending.keys()]) cancel(requestId, "ChatGPT relay page disconnected", { retryable: true });
    queue.length = 0;
    return { disconnected: true };
  }
  function status() {
    const connected = Boolean(clientId && now() - lastSeenAt <= livenessMs);
    return {
      connected,
      pending: pending.size,
      lastSeenAgoMs: lastSeenAt ? now() - lastSeenAt : null,
      lastResultAgoMs: health.lastResultAt ? now() - health.lastResultAt : null,
      lastStatus: health.lastStatus,
      consecutiveFailures: health.consecutiveFailures,
      timeouts: health.timeouts,
    };
  }
  return { connect, request, next, complete, disconnect, status, trace };
}

// 읽기 요청 간격을 429 이력에 맞춰 조절한다. 성공이 이어지면 간격이 min 쪽으로 줄고, 429 를 만나면
// 두 배로(최대 max) 늘어난다. 여러 작업이 같은 상태를 공유하도록 밖에서 만들어 넘긴다.
// 429 쿨다운 종료 시각도 함께 들고 있어, 작업이 끝나고 새 작업이 시작돼도 대기가 이어진다(서버 프로세스 안에서).
export function createPacer({ min = 300, start = 600, max = 4000, now = () => Date.now() } = {}) {
  let delay = start;
  let cooldownUntil = 0;
  return {
    current: () => Math.round(delay),
    cooldownLeft: () => Math.max(0, cooldownUntil - now()),
    coolDown(waitMs) { cooldownUntil = Math.max(cooldownUntil, now() + waitMs); },
    success() { delay = Math.max(min, delay * 0.92); },
    throttled() { delay = Math.min(max, Math.max(delay, min) * 2); },
  };
}

export function createRelayApi({ broker, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(), maxRetries = 8, backoffBaseMs = 5000, backoffCapMs = 300000,
  requestDelayMs = 1000, pacer = null, onRetry = () => {}, onRequest = () => {} } = {}) {
  assert(broker?.request, "Relay broker is required");
  let cooldownUntil = 0;
  const metrics = { requests: 0, retries: 0, rateLimits: 0, retryWaitMs: 0, pacingWaitMs: 0 };
  async function call(op, params, retry = true) {
    const retryLimit = retry ? maxRetries : 0;
    for (let attempt = 0; attempt <= retryLimit; attempt++) {
      const cooldown = Math.max(0, cooldownUntil - now(), pacer?.cooldownLeft() || 0);
      if (cooldown) await sleep(cooldown);
      metrics.requests++;
      onRequest({ op, attempt, count: metrics.requests });
      let result;
      try { result = await broker.request({ op, params }); }
      catch (error) {
        if (error?.retryable === false || attempt === retryLimit) throw error;
        const waitMs = Math.min(backoffBaseMs * (2 ** attempt), backoffCapMs);
        metrics.retries++; metrics.retryWaitMs += waitMs; onRetry({ type: "network", attempt: attempt + 1, waitMs });
        await sleep(waitMs); continue;
      }
      if (result.status === 429) pacer?.throttled();
      else if (result.ok) pacer?.success();
      if (!(RETRYABLE.has(result.status) || (result.status === 599 && READ_OPS.has(op))) || attempt === retryLimit) {
        const delay = pacer && READ_OPS.has(op) ? pacer.current() : requestDelayMs;
        if (delay) { metrics.pacingWaitMs += delay; await sleep(delay); }
        return result;
      }
      const waitMs = Math.min(backoffBaseMs * (2 ** attempt), backoffCapMs);
      metrics.retries++; metrics.retryWaitMs += waitMs;
      if (result.status === 429) { metrics.rateLimits++; cooldownUntil = Math.max(cooldownUntil, now() + waitMs); pacer?.coolDown(waitMs); }
      onRetry({ type: "http", status: result.status, attempt: attempt + 1, waitMs });
      await sleep(waitMs);
    }
  }
  return {
    metrics,
    accountInfo: () => call("accountInfo", {}, false),
    getConversation: (id) => call("getConversation", { id }),
    listConversations: ({ archived = false, offset = 0, limit = 100 } = {}) => call("listConversations", { archived, offset, limit }),
    listProjectSidebar: ({ cursor = "", limit = 20 } = {}) => call("listProjects", { cursor, limit }),
    listProjectConversations: (projectId, { cursor = "", limit = 50 } = {}) => call("listProjectConversations", { projectId, cursor, limit }),
    createProject: ({ name, instructions = "" }) => call("createProject", { name, instructions }, false),
    moveConversation: (id, projectId) => call("moveConversation", { id, projectId }, false),
    async patchConversation(id, body) {
      const result = await call("patchConversation", { id, body });
      if (!result.ok) throw new Error(`ChatGPT update failed: HTTP ${result.status}`);
      if (result.data?.success !== true) throw new Error("ChatGPT update was not explicitly confirmed");
      return result.data;
    },
  };
}
