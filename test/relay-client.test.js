// 화면 쪽 릴레이 클라이언트(public/assets/relay-client.js)를 가짜 window 로 시험한다.
// chatgpt.com 탭은 postMessage 로 요청을 받아 ack·결과를 돌려주는 가짜 peer 로 흉내 낸다.
import assert from "node:assert/strict";
import test from "node:test";

import { createRelayApi, createRelayBroker } from "../src/relay-api.js";

function fakeWindow() {
  const listeners = new Set();
  return {
    listeners, opener: null,
    addEventListener(type, fn) { if (type === "message") listeners.add(fn); },
    removeEventListener(type, fn) { listeners.delete(fn); },
    dispatch(event) { for (const fn of [...listeners]) fn(event); },
  };
}

async function setup({ pageBehaviour }) {
  const window = fakeWindow();
  globalThis.window = window;
  Object.defineProperty(globalThis, "navigator", { value: { sendBeacon() {} }, configurable: true, writable: true });
  globalThis.fetch = async () => ({ ok: true });
  const { startRelay } = await import("../public/assets/relay-client.js");
  const broker = createRelayBroker({ timeoutMs: 2000 });
  const RELAY = "relay-test";
  const api = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : {};
    if (url === "/relay/connect") return broker.connect(body.clientId);
    if (url === "/relay/next") return broker.next(body.clientId);
    if (url === "/relay/result") return broker.complete(body.clientId, body.requestId, body.result);
    throw new Error(`unexpected ${url}`);
  };
  const peer = {
    closed: false,
    postMessage(message) {
      pageBehaviour(message, (data) => window.dispatch({ origin: "https://chatgpt.com", source: peer, data }));
    },
  };
  const states = [];
  const relay = startRelay({ api, relayVersion: RELAY, onState: (state) => states.push(state), pageTimeoutMs: 150 });
  // 북마클릿 하트비트
  window.dispatch({ origin: "https://chatgpt.com", source: peer, data: { type: "chatgpt-relay-v2-ready", relayVersion: RELAY } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { broker, states, window, relay };
}

test("the relay client carries a request to the page and returns its result", async () => {
  const { broker, states, relay } = await setup({
    pageBehaviour: (message, reply) => {
      reply({ type: "chatgpt-relay-v2-ack", id: message.id });
      reply({ type: "chatgpt-relay-v2-result", id: message.id,
        result: { ok: true, status: 200, data: { accountId: "11111111-2222-4333-8444-555555555555" }, contentType: "application/json" } });
    },
  });
  assert.equal(states.at(-1).connected, true);
  const api = createRelayApi({ broker, requestDelayMs: 0 });
  const result = await api.accountInfo();
  assert.equal(result.ok, true);
  assert.equal(result.data.accountId, "11111111-2222-4333-8444-555555555555");
  relay.stop();
});

test("a page that never answers fails only that request with 599 and the loop keeps running", async () => {
  let calls = 0;
  const { broker, states, relay } = await setup({
    pageBehaviour: (message, reply) => {
      calls += 1;
      if (calls === 1) return;
      reply({ type: "chatgpt-relay-v2-result", id: message.id,
        result: { ok: true, status: 200, data: { accountId: "11111111-2222-4333-8444-555555555555" }, contentType: "application/json" } });
    },
  });
  const api = createRelayApi({ broker, requestDelayMs: 0, backoffBaseMs: 1, backoffCapMs: 2 });
  const first = await api.accountInfo();
  assert.equal(first.status, 599);
  assert.match(first.bodySnippet, /응답 시간 초과/);
  assert.equal(states.at(-1).connected, true);
  const second = await api.accountInfo();
  assert.equal(second.ok, true);
  relay.stop();
});
