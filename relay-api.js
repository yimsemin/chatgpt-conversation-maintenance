import { randomUUID } from "node:crypto";
import { validateRemoteOperation, validateRemoteResult } from "./remote-ops.js";
import { createRelayTrace } from "./relay-trace.js";

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

function assert(condition, message) { if (!condition) throw new Error(message); }

// timeoutMs: 한 요청의 왕복 제한. 대화 본문은 수 MB 라 목록 조회보다 오래 걸린다.
// livenessMs: 유지관리 창이 살아있다고 볼 기간. 둘을 묶으면 왕복 제한을 늘릴 때
// "페이지가 연결되지 않았습니다" 판정이 같이 둔해진다.
export function createRelayBroker({ timeoutMs = 90000, livenessMs = 30000,
  now = () => Date.now(), trace = createRelayTrace({ now }) } = {}) {
  const queue = [];
  const pending = new Map();
  let clientId = null;
  let lastSeenAt = 0;

  function connect(id) {
    assert(typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id), "Relay client ID is invalid");
    // 먼저 연결한 창이 릴레이를 소유한다. 새로 온 창이 빼앗게 하면, 밀려난 창이 페이지의
    // 500ms 하트비트로 루프를 다시 시작해 서로를 무한히 밀어내는 교착에 빠진다(2026-09-12 실측).
    // 소유 창이 조용해져 생존 기간이 지난 뒤에만 인수를 허용한다.
    if (clientId && clientId !== id && now() - lastSeenAt <= livenessMs) {
      trace.record("connect-refused", { clientId, note: `owned; ${id.slice(0, 8)} refused` });
      return { connected: false, reason: "relay-owned" };
    }
    if (clientId && clientId !== id) {
      trace.record("connect-replaced", { clientId, note: `stale; taken over by ${id.slice(0, 8)}` });
      for (const requestId of [...pending.keys()]) cancel(requestId, "Relay client was replaced");
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
    entry.resolve(validated);
    return { accepted: true };
  }
  function cancel(requestId, message = "Remote operation was cancelled") {
    const entry = pending.get(requestId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pending.delete(requestId);
    trace.record("cancel", { op: entry.operation.op, requestId, note: message });
    const error = new Error(message);
    error.retryable = false;
    entry.reject(error);
    return true;
  }
  function disconnect(id) {
    if (id !== clientId) return { disconnected: false };
    trace.record("disconnect", { clientId: id });
    clientId = null;
    for (const requestId of [...pending.keys()]) cancel(requestId, "ChatGPT relay page disconnected");
    queue.length = 0;
    return { disconnected: true };
  }
  function status() {
    return { connected: Boolean(clientId && now() - lastSeenAt <= livenessMs), pending: pending.size };
  }
  return { connect, request, next, complete, disconnect, status, trace };
}

export function createRelayApi({ broker, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(), maxRetries = 8, backoffBaseMs = 5000, backoffCapMs = 300000,
  requestDelayMs = 1000, onRetry = () => {} } = {}) {
  assert(broker?.request, "Relay broker is required");
  let cooldownUntil = 0;
  const metrics = { requests: 0, retries: 0, rateLimits: 0, retryWaitMs: 0, pacingWaitMs: 0 };
  async function call(op, params, retry = true) {
    const retryLimit = retry ? maxRetries : 0;
    for (let attempt = 0; attempt <= retryLimit; attempt++) {
      const cooldown = Math.max(0, cooldownUntil - now());
      if (cooldown) await sleep(cooldown);
      metrics.requests++;
      let result;
      try { result = await broker.request({ op, params }); }
      catch (error) {
        if (error?.retryable === false || attempt === retryLimit) throw error;
        const waitMs = Math.min(backoffBaseMs * (2 ** attempt), backoffCapMs);
        metrics.retries++; metrics.retryWaitMs += waitMs; onRetry({ type: "network", attempt: attempt + 1, waitMs });
        await sleep(waitMs); continue;
      }
      if (!RETRYABLE.has(result.status) || attempt === retryLimit) {
        if (requestDelayMs) { metrics.pacingWaitMs += requestDelayMs; await sleep(requestDelayMs); }
        return result;
      }
      const waitMs = Math.min(backoffBaseMs * (2 ** attempt), backoffCapMs);
      metrics.retries++; metrics.retryWaitMs += waitMs;
      if (result.status === 429) { metrics.rateLimits++; cooldownUntil = Math.max(cooldownUntil, now() + waitMs); }
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
    listProjects: (cursor = "") => call("listProjects", { cursor, limit: 20 }),
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
