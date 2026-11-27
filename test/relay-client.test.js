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

async function setup({ pageBehaviour, bookmarkletVersion }) {
  const window = fakeWindow();
  globalThis.window = window;
  Object.defineProperty(globalThis, "navigator", { value: { sendBeacon() {} }, configurable: true, writable: true });
  globalThis.fetch = async () => ({ ok: true });
  const { startRelay } = await import("../public/assets/relay-client.js");
  const broker = createRelayBroker({ timeoutMs: 2000 });
  const RELAY = "relay-9.9.1";
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
  const sendReady = () => window.dispatch({
    origin: "https://chatgpt.com", source: peer,
    data: { type: "chatgpt-relay-v2-ready", relayVersion: bookmarkletVersion ?? RELAY },
  });
  sendReady();
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { broker, states, sendReady, relay };
}

test("a compatible older bookmarklet carries requests and reports its available update once per state", async (t) => {
  const { broker, states, sendReady, relay } = await setup({
    bookmarkletVersion: "relay-9.9.0",
    pageBehaviour: (message, reply) => {
      reply({ type: "chatgpt-relay-v2-ack", id: message.id });
      reply({ type: "chatgpt-relay-v2-result", id: message.id,
        result: { ok: true, status: 200, data: { accountId: "11111111-2222-4333-8444-555555555555" }, contentType: "application/json" } });
    },
  });
  t.after(() => relay.stop());
  assert.equal(states.at(-1).connected, true);
  assert.equal(states.at(-1).updateAvailable, true);
  // 2026-11-21: 매 하트비트의 중복 상태 알림이 화면 세션을 다시 조회했다.
  const initialStateCount = states.length;
  sendReady();
  sendReady();
  assert.equal(states.length, initialStateCount);
  const api = createRelayApi({ broker, requestDelayMs: 0 });
  const result = await api.accountInfo();
  assert.equal(result.ok, true);
  assert.equal(result.data.accountId, "11111111-2222-4333-8444-555555555555");
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
  assert.match(first.bodySnippet, /did not respond/);
  assert.equal(states.at(-1).connected, true);
  const second = await api.accountInfo();
  assert.equal(second.ok, true);
  relay.stop();
});
