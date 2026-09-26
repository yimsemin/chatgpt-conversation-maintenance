import assert from "node:assert/strict";
import test from "node:test";

import { collectConversationCatalog } from "../src/catalog.js";
import { createPacer, createRelayApi, createRelayBroker } from "../src/relay-api.js";
import { attachFakePage, createFakeChatGPT, fakeConversationId, fakeProjectId } from "./support/fake-chatgpt.js";

function world() {
  const fake = createFakeChatGPT({
    projects: [{ id: fakeProjectId(1), name: "Project A" }, { id: fakeProjectId(2), name: "Empty" }],
    conversations: [
      { id: fakeConversationId(1), title: "하나 — 결과", gizmo_id: fakeProjectId(1) },
      { id: fakeConversationId(2), title: "둘 — 결과" },
      { id: fakeConversationId(3), title: "셋 — 결과", is_archived: true },
    ],
  });
  const broker = createRelayBroker({ timeoutMs: 300 });
  const page = attachFakePage(broker, fake);
  const api = createRelayApi({ broker, requestDelayMs: 0, backoffBaseMs: 1, backoffCapMs: 2, maxRetries: 4 });
  return { fake, broker, page, api };
}

test("the catalog collector works end to end against the fake ChatGPT", async () => {
  const { fake, page, api } = world();
  try {
    const catalog = await collectConversationCatalog(api);
    assert.equal(catalog.conversations.length, 3);
    assert.equal(catalog.conversations.find((c) => c.conversationId === fakeConversationId(1)).projectName, "Project A");
    assert.equal(catalog.counts.archived, 1);
    assert.ok(fake.stats.calls > 3);
  } finally { await page.stop(); }
});

test("a 429 burst is retried transparently and a hung page fails only that request", async () => {
  const { fake, page, api } = world();
  try {
    fake.inject({ op: "listConversations", status: 429, times: 2 });
    const catalog = await collectConversationCatalog(api);
    assert.equal(catalog.conversations.length, 3);
    assert.equal(fake.stats.injected, 2);
    fake.hang({ op: "getConversation", times: 1 });
    await assert.rejects(api.getConversation(fakeConversationId(1)), /timed out/);
    const again = await api.getConversation(fakeConversationId(1));
    assert.equal(again.ok, true);
  } finally { await page.stop(); }
});

test("the broker reports connection health for the screen", async () => {
  const { fake, broker, page, api } = world();
  try {
    await api.getConversation(fakeConversationId(1));
    let status = broker.status();
    assert.equal(status.connected, true);
    assert.equal(status.lastStatus, 200);
    assert.equal(status.consecutiveFailures, 0);
    fake.inject({ op: "getConversation", status: 500, times: 1 });
    await api.getConversation(fakeConversationId(1));
    status = broker.status();
    assert.equal(status.consecutiveFailures, 0);
    assert.ok(status.lastResultAgoMs >= 0);
  } finally { await page.stop(); }
});

test("the read pacer slows down after a 429 and speeds up again on success", async () => {
  const pacer = createPacer({ min: 100, start: 200, max: 1000 });
  assert.equal(pacer.current(), 200);
  pacer.throttled();
  assert.equal(pacer.current(), 400);
  pacer.throttled(); pacer.throttled(); pacer.throttled();
  assert.equal(pacer.current(), 1000);
  for (let i = 0; i < 40; i++) pacer.success();
  assert.equal(pacer.current(), 100);

  const { fake, broker, page } = world();
  try {
    const waits = [];
    const shared = createPacer({ min: 5, start: 5, max: 50 });
    const api = createRelayApi({ broker, requestDelayMs: 0, pacer: shared, backoffBaseMs: 1, backoffCapMs: 2,
      sleep: async (ms) => { waits.push(ms); } });
    fake.inject({ op: "listConversations", status: 429, times: 1 });
    await api.listConversations({ archived: false, offset: 0, limit: 10 });
    assert.ok(waits.at(-1) > 5, `expected a slowed pacing wait after the 429, got ${waits}`);
  } finally { await page.stop(); }
});

test("a 429 cooldown carries over to the next job through the shared pacer", async () => {
  const { fake, broker, page } = world();
  try {
    let clock = 1000;
    const shared = createPacer({ min: 5, start: 5, max: 50, now: () => clock });
    const first = createRelayApi({ broker, requestDelayMs: 0, pacer: shared, backoffBaseMs: 4000, backoffCapMs: 4000,
      now: () => clock, sleep: async (ms) => { clock += ms; } });
    fake.inject({ op: "listConversations", status: 429, times: 1 });
    await first.listConversations({ archived: false, offset: 0, limit: 10 });
    assert.equal(shared.cooldownLeft(), 0, "the first job already waited the cooldown out");

    shared.coolDown(3000);
    const waits = [];
    const second = createRelayApi({ broker, requestDelayMs: 0, pacer: shared, now: () => clock,
      sleep: async (ms) => { waits.push(ms); clock += ms; } });
    await second.listConversations({ archived: false, offset: 0, limit: 10 });
    assert.equal(waits[0], 3000, `a new job should wait out the remaining cooldown, got ${waits}`);
  } finally { await page.stop(); }
});
