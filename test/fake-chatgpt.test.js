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
