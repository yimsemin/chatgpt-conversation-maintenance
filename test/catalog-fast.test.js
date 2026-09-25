import assert from "node:assert/strict";
import test from "node:test";

import {
  FastCatalogUnsupported, collectConversationCatalog, collectFastCatalog, collectIncrementalCatalog, probeFastCatalog,
} from "../catalog.js";
import { createRelayApi, createRelayBroker } from "../relay-api.js";
import { attachFakePage, createFakeChatGPT, fakeConversationId, fakeProjectId } from "./support/fake-chatgpt.js";

function setup(options = {}, count = 250) {
  const projects = [{ id: fakeProjectId(1), name: "A" }, { id: fakeProjectId(2), name: "B" }];
  const conversations = [];
  for (let i = 1; i <= count; i++) {
    conversations.push({ id: fakeConversationId(i), title: `주제 ${i} — 결과`, gizmo_id: i % 3 === 0 ? projects[i % 2].id : null,
      is_archived: i % 50 === 0 });
  }
  const fake = createFakeChatGPT({ projects, conversations, ...options });
  const broker = createRelayBroker({ timeoutMs: 500 });
  const page = attachFakePage(broker, fake);
  const api = createRelayApi({ broker, requestDelayMs: 0 });
  return { fake, page, api };
}

const stateFrom = (catalog) => ({ ...catalog, kind: "conversation-maintenance-state" });

test("the fast catalog equals the crawled catalog with far fewer requests", async () => {
  const { fake, page, api } = setup();
  try {
    const crawl = await collectConversationCatalog(api);
    const crawlCalls = fake.stats.calls;
    const before = fake.stats.calls;
    const fast = await collectFastCatalog(api);
    const fastCalls = fake.stats.calls - before;
    assert.deepEqual(fast.conversations, crawl.conversations);
    assert.ok(fastCalls < crawlCalls, `${fastCalls} !< ${crawlCalls}`);
  } finally { await page.stop(); }
});

test("the probe reports ok when both strategies agree and unsupported when the list has no gizmo field", async () => {
  const good = setup();
  try {
    const result = await probeFastCatalog(good.api);
    assert.equal(result.ok, true);
    assert.equal(result.counts.project, 0);
  } finally { await good.page.stop(); }
  const bad = setup({ listIncludesGizmo: false }, 30);
  try {
    const result = await probeFastCatalog(bad.api);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unsupported");
    await assert.rejects(collectFastCatalog(bad.api), FastCatalogUnsupported);
  } finally { await bad.page.stop(); }
});

test("the incremental catalog reads only the top of the list and reports what changed", async () => {
  const { fake, page, api } = setup();
  try {
    const baseline = stateFrom(await collectConversationCatalog(api));
    fake.addConversation({ id: fakeConversationId(9001), title: "새 대화" });
    fake.conversations.get(fakeConversationId(5)).title = "바뀐 — 제목";
    fake.conversations.get(fakeConversationId(5)).update_time += 1000;
    fake.conversations.get(fakeConversationId(7)).gizmo_id = fakeProjectId(1);
    fake.conversations.get(fakeConversationId(7)).update_time += 2000;
    const before = fake.stats.byOp.listConversations || 0;
    const { catalog, changed, pages } = await collectIncrementalCatalog({ api, baseline, stopAfterUnchanged: 20 });
    assert.equal(changed, 3);
    assert.ok(pages <= 3, `pages ${pages}`);
    assert.equal((fake.stats.byOp.listConversations || 0) - before, pages + 0);
    const byId = new Map(catalog.conversations.map((item) => [item.conversationId, item]));
    assert.equal(byId.get(fakeConversationId(9001)).title, "새 대화");
    assert.equal(byId.get(fakeConversationId(5)).title, "바뀐 — 제목");
    assert.equal(byId.get(fakeConversationId(7)).projectName, "A");
    assert.equal(catalog.conversations.length, baseline.conversations.length + 1);
  } finally { await page.stop(); }
});
