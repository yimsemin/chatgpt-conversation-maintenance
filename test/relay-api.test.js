import assert from "node:assert/strict";
import test from "node:test";
import { createPacer, createRelayApi, createRelayBroker } from "../src/relay-api.js";
import { createRelayTrace } from "../src/relay-trace.js";
import { APP_RELEASE, RELAY_PROTOCOL_VERSION } from "../src/app-version.js";
import { validateRelayVersion } from "../src/remote-relay.js";

test("broker queues one validated operation and resolves its result", async () => {
  const broker = createRelayBroker({ timeoutMs: 1000 });
  const clientId = "11111111-1111-4111-8111-111111111111";
  broker.connect(clientId);
  const response = broker.request({ op: "accountInfo", params: {} });
  const next = broker.next(clientId);
  assert.equal(next.request.op, "accountInfo");
  broker.complete(clientId, next.request.id, { ok: true, status: 200, data: { accountId: clientId }, contentType: "application/json" });
  assert.equal((await response).data.accountId, clientId);
});

test("relay adapter preserves no-retry semantics for ambiguous writes", async () => {
  let calls = 0;
  const broker = { request: async () => { calls++; return { ok: false, status: 500, data: null, contentType: "application/json" }; } };
  const api = createRelayApi({ broker, requestDelayMs: 0, maxRetries: 3, sleep: async () => {} });
  await api.createProject({ name: "프로젝트" });
  assert.equal(calls, 1);
  await api.moveConversation("11111111-1111-4111-8111-111111111111", `g-p-${"a".repeat(32)}`);
  assert.equal(calls, 2);
});

test("getConversation tries can cap the read retries (599 is retried up to that many attempts)", async () => {
  let calls = 0;
  const broker = { request: async () => { calls++; return { ok: false, status: 599, data: null, contentType: "application/json" }; } };
  const api = createRelayApi({ broker, requestDelayMs: 0, maxRetries: 8, sleep: async () => {} });
  const result = await api.getConversation("11111111-1111-4111-8111-111111111111", { tries: 4 });
  assert.equal(result.status, 599);
  assert.equal(calls, 4);
  calls = 0;
  await api.getConversation("11111111-1111-4111-8111-111111111111");
  assert.equal(calls, 9, "the default keeps 8 retries after the first attempt");
});

test("writes keep the fixed delay but follow the pacer once a 429 raised it; reads follow the pacer alone", async () => {
  const slept = [];
  let status = 200;
  const broker = { request: async () => ({ ok: status === 200, status, data: { success: true }, contentType: "application/json" }) };
  const pacer = createPacer({ min: 300, start: 600, max: 4000 });
  const api = createRelayApi({ broker, requestDelayMs: 1000, pacer, maxRetries: 0, sleep: async (ms) => { slept.push(ms); } });
  await api.moveConversation("11111111-1111-4111-8111-111111111111", `g-p-${"a".repeat(32)}`);
  await api.getConversation("11111111-1111-4111-8111-111111111111");
  assert.deepEqual(slept.map((ms) => Math.round(ms / 10) * 10), [1000, 510], "a write waits at least the fixed delay; a read waits the pacer's delay");
  slept.length = 0;
  status = 429;
  pacer.throttled(); pacer.throttled(); pacer.throttled(); // 600 → … → 4000 상한
  await api.moveConversation("11111111-1111-4111-8111-111111111111", `g-p-${"a".repeat(32)}`);
  assert.equal(slept.at(-1), 4000, "after throttling the write delay grows with the pacer");
});

test("invalid page results reject immediately and clear the pending operation", async () => {
  const broker = createRelayBroker({ timeoutMs: 1000 });
  const clientId = "11111111-1111-4111-8111-111111111111";
  broker.connect(clientId);
  const response = broker.request({ op: "accountInfo", params: {} });
  const next = broker.next(clientId);
  const outcome = broker.complete(clientId, next.request.id, {
    ok: true, status: 200, data: { accountId: "invalid" }, contentType: "application/json",
  });
  assert.deepEqual(outcome, { accepted: false, reason: "invalid-result" });
  await assert.rejects(response, /Account response is invalid/);
  assert.equal(broker.status().pending, 0);
});

test("a late result is ignored instead of breaking the relay loop", async () => {
  const broker = createRelayBroker({ timeoutMs: 5 });
  const clientId = "11111111-1111-4111-8111-111111111111";
  broker.connect(clientId);
  const response = broker.request({ op: "accountInfo", params: {} });
  const next = broker.next(clientId);
  await assert.rejects(response, /timed out/);
  // 시간 초과 뒤 도착한 결과는 400 이 아니라 무시로 처리돼야 한다.
  assert.deepEqual(broker.complete(clientId, next.request.id, {
    ok: true, status: 200, data: { accountId: clientId }, contentType: "application/json",
  }), { accepted: false, reason: "not-pending" });
});

test("a stale owner's takeover fails its pending work at once", async () => {
  let clock = 0;
  const broker = createRelayBroker({ timeoutMs: 60000, livenessMs: 1000, now: () => clock });
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  broker.connect(first);
  const response = broker.request({ op: "accountInfo", params: {} });
  clock = 2000;
  assert.deepEqual(broker.connect(second), { connected: true });
  await assert.rejects(response, /client was replaced/);
  assert.equal(broker.status().pending, 0);
  assert.equal(broker.next(second).request, null);
});

test("the same client reconnecting keeps its pending work", async () => {
  const broker = createRelayBroker({ timeoutMs: 60000 });
  const clientId = "11111111-1111-4111-8111-111111111111";
  broker.connect(clientId);
  const response = broker.request({ op: "accountInfo", params: {} });
  broker.connect(clientId);
  const next = broker.next(clientId);
  assert.equal(next.request.op, "accountInfo");
  broker.complete(clientId, next.request.id, {
    ok: true, status: 200, data: { accountId: clientId }, contentType: "application/json",
  });
  assert.equal((await response).status, 200);
});

test("the trace records each boundary without request content", async () => {
  const broker = createRelayBroker({ timeoutMs: 1000 });
  const clientId = "11111111-1111-4111-8111-111111111111";
  broker.connect(clientId);
  const response = broker.request({ op: "accountInfo", params: {} });
  const next = broker.next(clientId);
  broker.complete(clientId, next.request.id, {
    ok: true, status: 200, data: { accountId: clientId }, contentType: "application/json",
  });
  await response;
  const stages = broker.trace.list().map((event) => event.stage);
  assert.deepEqual(stages, ["connect", "enqueue", "dequeue", "result-accepted"]);
  const accepted = broker.trace.list().at(-1);
  assert.equal(accepted.op, "accountInfo");
  assert.equal(accepted.status, 200);
  assert.equal(accepted.requestId.length, 8);
  assert.deepEqual(Object.keys(accepted).sort(),
    ["atMs", "clientId", "elapsedMs", "note", "op", "requestId", "seq", "stage", "status"]);
});

test("page relay timeout fails immediately instead of entering HTTP backoff", async () => {
  let retries = 0;
  const broker = createRelayBroker({ timeoutMs: 5 });
  broker.connect("00000000-0000-4000-8000-000000000000");
  const api = createRelayApi({ broker, requestDelayMs: 0, onRetry: () => { retries++; } });
  await assert.rejects(api.listConversations(), /page relay timed out/);
  assert.equal(retries, 0);
});

test("an invalid operation fails at once instead of entering backoff", async () => {
  let retries = 0;
  const broker = createRelayBroker({ timeoutMs: 60000 });
  broker.connect("11111111-1111-4111-8111-111111111111");
  const api = createRelayApi({ broker, requestDelayMs: 0, sleep: async () => {}, onRetry: () => { retries++; } });
  await assert.rejects(api.getConversation("not-a-conversation-id"), /Conversation ID is invalid/);
  assert.equal(retries, 0);
  assert.deepEqual(broker.trace.list().map((event) => event.stage), ["connect", "op-rejected"]);
});

test("the round-trip limit is independent of the liveness window", async () => {
  let clock = 0;
  const broker = createRelayBroker({ timeoutMs: 60000, livenessMs: 1000, now: () => clock });
  const clientId = "11111111-1111-4111-8111-111111111111";
  broker.connect(clientId);
  // 왕복 제한이 길어도 창이 조용하면 연결이 끊긴 것으로 본다.
  clock = 2000;
  assert.throws(() => broker.request({ op: "accountInfo", params: {} }), /not connected/);
  // 폴링이 들어오면 다시 받아들인다.
  broker.next(clientId);
  const pending = broker.request({ op: "accountInfo", params: {} });
  assert.equal(broker.status().pending, 1);
  // 실제 60초 타이머를 남기지 않도록 정리한다.
  broker.disconnect(clientId);
  await assert.rejects(pending, /disconnected/);
  assert.equal(broker.status().pending, 0);
});

// 유지관리 창이 둘이면, 새 창이 릴레이를 빼앗게 두면 밀려난 창이 페이지 하트비트로 루프를
// 다시 시작해 서로를 무한히 밀어낸다(2026-09-12 실측). 먼저 연결한 창이 소유한다.
test("a second window is refused instead of stealing the relay", async () => {
  let clock = 0;
  const broker = createRelayBroker({ timeoutMs: 60000, livenessMs: 30000, now: () => clock });
  const owner = "11111111-1111-4111-8111-111111111111";
  const intruder = "22222222-2222-4222-8222-222222222222";
  assert.deepEqual(broker.connect(owner), { connected: true });
  clock = 1000;
  assert.deepEqual(broker.connect(intruder), { connected: false, reason: "relay-owned" });
  // 소유 창의 작업은 그대로 살아 있어야 한다.
  const pending = broker.request({ op: "accountInfo", params: {} });
  assert.equal(broker.next(owner).request.op, "accountInfo");
  assert.throws(() => broker.next(intruder), /not connected/);
  broker.disconnect(owner);
  await assert.rejects(pending, /disconnected/);
  assert.equal(broker.trace.list().some((event) => event.stage === "connect-refused"), true);
});

test("a silent owner is taken over only after the liveness window passes", () => {
  let clock = 0;
  const broker = createRelayBroker({ timeoutMs: 60000, livenessMs: 1000, now: () => clock });
  const owner = "11111111-1111-4111-8111-111111111111";
  const next = "22222222-2222-4222-8222-222222222222";
  broker.connect(owner);
  clock = 2000;
  assert.deepEqual(broker.connect(next), { connected: true });
  assert.throws(() => broker.next(owner), /not connected/);
});

test("a window that cannot deliver a waiting request loses the relay to the window that asks for it", async () => {
  let clock = 0;
  const broker = createRelayBroker({ timeoutMs: 120000, livenessMs: 120000, stuckMs: 20000, now: () => clock });
  const stuck = "11111111-1111-4111-8111-111111111111";
  const active = "22222222-2222-4222-8222-222222222222";
  broker.connect(stuck);
  const first = broker.request({ op: "accountInfo", params: {} });
  first.catch(() => {});
  clock = 10000;
  assert.deepEqual(broker.connect(active), { connected: false, reason: "relay-owned" }, "not yet stuck");
  clock = 25000;
  assert.deepEqual(broker.connect(active), { connected: true });
  await assert.rejects(first, /replaced/);
  assert.equal(broker.trace.list().some((event) => /stuck; taken over/.test(event.note || "")), true);
  // 새 소유 창이 일을 받는다.
  const second = broker.request({ op: "accountInfo", params: {} });
  assert.equal(broker.next(active).request.op, "accountInfo");
  second.catch(() => {});
  broker.disconnect(active);
});

test("the trace keeps only fixed diagnostic fields, refuses unknown stages and caps its buffer", () => {
  const trace = createRelayTrace({ now: () => 1000 });
  const event = trace.record("post-to-page", {
    op: "listConversations",
    requestId: "abcdef01-2345-6789-abcd-ef0123456789",
    clientId: "11111111-2222-3333-4444-555555555555",
    status: 200,
    elapsedMs: 42,
  });
  assert.equal(event.requestId, "abcdef01");
  assert.equal(event.clientId, "11111111");
  assert.equal(event.op, "listConversations");
  assert.equal(event.status, 200);

  assert.equal(trace.record("exfiltrate", { op: "x" }), null);
  const odd = trace.record("loop-error", { note: { secret: "token" }, status: "200" });
  assert.equal(odd.note, null);
  assert.equal(odd.status, null);

  const capped = createRelayTrace({ max: 3 });
  for (let index = 0; index < 10; index++) capped.record("enqueue", { op: "accountInfo" });
  assert.equal(capped.list().length, 3);
  assert.equal(capped.list().at(-1).seq, 10);
});

test("relay connection accepts only the current release and protocol", () => {
  assert.doesNotThrow(() => validateRelayVersion(APP_RELEASE, RELAY_PROTOCOL_VERSION));
  assert.throws(() => validateRelayVersion("old-release", RELAY_PROTOCOL_VERSION), /version mismatch/);
  assert.throws(() => validateRelayVersion(APP_RELEASE, RELAY_PROTOCOL_VERSION - 1), /version mismatch/);
});
