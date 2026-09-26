import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectScopedCatalog } from "../catalog.js";
import { orderOldestFirst } from "../decision-compile.js";
import { checkRenameOrder } from "../finalize.js";
import { scanMaintenanceRun, validateScope } from "../scan.js";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";
const ID4 = "44444444-4444-4444-8444-444444444444";
const ID5 = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-09-26T00:00:00Z");
const day = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
const PA = `g-p-${"a".repeat(32)}`;
const PB = `g-p-${"b".repeat(32)}`;
const UNKNOWN = `g-p-${"c".repeat(32)}`;
const ok = (data) => ({ ok: true, status: 200, data });

// 목록 항목: 프로젝트 소속(gizmo_id)이 들어 있다. 사용자 정의 GPT(g-…)는 프로젝트가 아니다.
const listItems = [
  { id: ID1, title: "미배치 — 하나", update_time: day(1), gizmo_id: null },
  { id: ID2, title: "프로젝트 A — 대화", update_time: day(2), gizmo_id: PA },
  { id: ID3, title: "사용자 정의 GPT — 대화", update_time: day(3), gizmo_id: "g-abcdef" },
  { id: ID4, title: "오래된 — 대화", update_time: day(40), gizmo_id: null },
  { id: ID5, title: "모르는 프로젝트 — 대화", update_time: day(4), gizmo_id: UNKNOWN },
];

// 호출을 세는 모의 API. 프로젝트 A만 자기 대화 목록을 갖고 있다.
function api() {
  const calls = { list: [], projectList: [], sidebar: 0 };
  return {
    calls,
    listProjectSidebar: async () => { calls.sidebar += 1; return ok({ items: [{ id: PA, display: { name: "프로젝트 A" } }, { id: PB, display: { name: "프로젝트 B" } }] }); },
    listProjectConversations: async (projectId, options) => {
      calls.projectList.push({ projectId, limit: options.limit });
      return ok({ items: projectId === PA ? [{ id: ID2, title: "프로젝트 A — 대화", update_time: day(2), gizmo_id: PA }] : [] });
    },
    listConversations: async ({ archived, offset, limit }) => {
      calls.list.push({ archived, offset });
      const items = listItems.slice(offset, offset + limit);
      return ok({ items, total: listItems.length, has_next: offset + items.length < listItems.length });
    },
    getConversation: async (id) => ok({ conversation_id: id, id, title: listItems.find((item) => item.id === id).title, create_time: 1,
      mapping: { root: { id: "root", message: null }, one: { id: "one", message: { content: { parts: ["안녕"] }, metadata: {} } } } }),
  };
}

test("scope validation accepts only the four scope kinds", () => {
  assert.deepEqual(validateScope({ kind: "unassigned" }), { kind: "unassigned" });
  assert.deepEqual(validateScope({ kind: "all", extra: 1 }), { kind: "all" });
  assert.deepEqual(validateScope({ kind: "recent", days: 7, extra: 1 }), { kind: "recent", days: 7 });
  assert.throws(() => validateScope({ kind: "everything" }), /종류/);
  assert.throws(() => validateScope({ kind: "recent", days: 0 }), /일수/);
  assert.throws(() => validateScope({ kind: "recent", days: 1.5 }), /일수/);
  assert.throws(() => validateScope({ kind: "project", projectName: " A " }), /프로젝트 이름/);
  assert.deepEqual(validateScope({ kind: "project", projectName: "A" }), { kind: "project", projectNames: ["A"] }, "the old single-name form is accepted");
  assert.deepEqual(validateScope({ kind: "project", projectNames: ["A", "B", "A"] }), { kind: "project", projectNames: ["A", "B"] });
  assert.throws(() => validateScope({ kind: "project", projectNames: [] }), /1~20/);
  assert.throws(() => validateScope(null), /범위/);
});

test("the project scope reads only that project and leaves other project counts unknown", async () => {
  const fake = api();
  const catalog = await collectScopedCatalog(fake, { kind: "project", projectNames: ["프로젝트 A"] }, () => NOW);
  assert.deepEqual(catalog.conversations.map((c) => [c.conversationId, c.projectName]), [[ID2, "프로젝트 A"]]);
  assert.equal(fake.calls.list.length, 0, "the general conversation list is not read");
  assert.deepEqual(fake.calls.projectList.map((c) => c.projectId), [PA]);
  assert.deepEqual(catalog.projects.map((p) => [p.projectName, p.conversationCount]), [["프로젝트 A", 1], ["프로젝트 B", null]]);
  assert.equal(catalog.scope.complete, false);
  await assert.rejects(() => collectScopedCatalog(fake, { kind: "project", projectNames: ["없는 프로젝트"] }, () => NOW), /프로젝트를 찾을 수 없습니다/);
});

test("the unassigned scope reads the list once, skips archived pages, and treats custom GPTs as projectless", async () => {
  const fake = api();
  const catalog = await collectScopedCatalog(fake, { kind: "unassigned" }, () => NOW);
  assert.deepEqual(catalog.conversations.map((c) => c.conversationId).sort(), [ID1, ID3, ID4].sort());
  assert.equal(fake.calls.list.every((call) => call.archived === false), true);
  // 다른 프로젝트로 옮길 후보를 고르는 데 쓰일 표본 제목은 프로젝트마다 작은 한 페이지만 읽는다.
  assert.deepEqual(fake.calls.projectList.map((c) => c.limit), [10, 10]);
  assert.equal(catalog.projects.find((p) => p.projectName === "프로젝트 A").sampleTitles[0], "프로젝트 A — 대화");
  assert.equal(catalog.projects.every((p) => p.conversationCount === null), true);
});

test("the recent scope stops paging at the cutoff and drops conversations of unknown projects", async () => {
  const fake = api();
  const catalog = await collectScopedCatalog(fake, { kind: "recent", days: 7 }, () => NOW);
  assert.deepEqual(catalog.conversations.map((c) => [c.conversationId, c.projectName]).sort(),
    [[ID1, null], [ID2, "프로젝트 A"], [ID3, null]].sort());
  assert.equal(catalog.conversations.some((c) => c.conversationId === ID5), false);
});

test("a scoped scan collects only the scope and records it in the inventory", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-maintenance-scope-test-"));
  try {
    const fake = api();
    const result = await scanMaintenanceRun({ runDir: join(root, "run"), api: fake, scope: { kind: "unassigned" }, now: () => NOW });
    assert.equal(result.inventory.source.mode, "scope");
    assert.deepEqual(result.inventory.source.scope, { kind: "unassigned" });
    assert.equal(result.inventory.counts.candidates, 3);
    assert.deepEqual(result.inventory.conversations[0].reasons, ["scope"]);
    assert.equal(result.catalog.scope.complete, false);

    const empty = await scanMaintenanceRun({ runDir: join(root, "run2"), api: fake, scope: { kind: "project", projectNames: ["프로젝트 B"] }, now: () => NOW });
    assert.equal(empty.inventory.counts.candidates, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("title changes are planned oldest conversation first so their relative list order survives", () => {
  const inventoryById = new Map([
    [ID1, { updateTime: day(1) }], [ID2, { updateTime: day(30) }], [ID3, { updateTime: null }], [ID4, { updateTime: day(30) }],
  ]);
  const actions = [ID1, ID2, ID3, ID4].map((conversationId) => ({ conversationId }));
  assert.deepEqual(orderOldestFirst(actions, inventoryById).map((a) => a.conversationId), [ID3, ID2, ID4, ID1]);
  assert.deepEqual(actions.map((a) => a.conversationId), [ID1, ID2, ID3, ID4], "input is not mutated");
});

test("the rename order check compares the original order with the times recorded in the receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-maintenance-order-test-"));
  try {
    const inventory = { conversations: [{ conversationId: ID1, updateTime: day(30) }, { conversationId: ID2, updateTime: day(20) }, { conversationId: ID3, updateTime: day(10) }] };
    const write = (afters) => {
      rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "r.json"), JSON.stringify({ results: [ID1, ID2, ID3].map((conversationId, index) => ({
        conversationId, ok: true, mutations: [{ type: "rename", title: "새 제목 — 결과", updateTime: afters[index] }] })) }));
    };
    write([day(0.003), day(0.002), day(0.001)]);
    assert.deepEqual(checkRenameOrder(inventory, root), { renamed: 3, preserved: true, outOfOrder: [] });
    write([day(0.001), day(0.002), day(0.003)]);
    const flipped = checkRenameOrder(inventory, root);
    assert.equal(flipped.preserved, false);
    assert.deepEqual(flipped.outOfOrder, [ID2, ID3]);
    assert.deepEqual(checkRenameOrder(inventory, join(root, "missing")), { renamed: 0, preserved: true, outOfOrder: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("several projects can be scanned at once and each gets its own count and latest activity", async () => {
  const fake = api();
  const catalog = await collectScopedCatalog(fake, { kind: "project", projectNames: ["프로젝트 A", "프로젝트 B"] }, () => NOW);
  assert.deepEqual(fake.calls.projectList.map((c) => c.projectId), [PA, PB]);
  const byName = Object.fromEntries(catalog.projects.map((p) => [p.projectName, p]));
  assert.equal(byName["프로젝트 A"].conversationCount, 1);
  assert.equal(byName["프로젝트 B"].conversationCount, 0);
  assert.equal(byName["프로젝트 A"].latestUpdate, day(2));
});
