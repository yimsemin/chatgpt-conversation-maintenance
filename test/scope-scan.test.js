import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { withTemp } from "./support/tmp.js";

import { collectScopedCatalog } from "../src/catalog.js";
import { countDownloaded, finishPartialScan, keptTitleMap, readScanDraft, reusableBodyDirs, scanMaintenanceRun, validateScope } from "../src/scan.js";

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

test("scope validation accepts only the five scope kinds", () => {
  assert.deepEqual(validateScope({ kind: "unassigned" }), { kind: "unassigned" });
  assert.deepEqual(validateScope({ kind: "unassigned", days: 14 }), { kind: "unassigned", days: 14 });
  assert.throws(() => validateScope({ kind: "unassigned", days: 0 }), /기간/);
  assert.deepEqual(validateScope({ kind: "all", extra: 1 }), { kind: "all" });
  assert.deepEqual(validateScope({ kind: "recent", days: 7, extra: 1 }), { kind: "recent", days: 7 });
  assert.throws(() => validateScope({ kind: "everything" }), /종류/);
  assert.throws(() => validateScope({ kind: "recent", days: 0 }), /일수/);
  assert.throws(() => validateScope({ kind: "recent", days: 1.5 }), /일수/);
  assert.throws(() => validateScope({ kind: "project", projectNames: [" A "] }), /프로젝트 이름/);
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

test("the unassigned scope reads only the conversation list: no project reads, custom GPTs count as projectless", async () => {
  const fake = api();
  const catalog = await collectScopedCatalog(fake, { kind: "unassigned" }, () => NOW, () => {}, { knownProjects: ["프로젝트 A"] });
  assert.deepEqual(catalog.conversations.map((c) => c.conversationId).sort(), [ID1, ID3, ID4].sort());
  assert.equal(fake.calls.list.every((call) => call.archived === false), true);
  assert.equal(fake.calls.sidebar, 0);
  assert.equal(fake.calls.projectList.length, 0);
  assert.deepEqual(catalog.projects.map((p) => [p.projectName, p.conversationCount]), [["프로젝트 A", null]], "only known projects are context");
});

test("the unassigned scope can be limited to recent days and stops paging at the cutoff", async () => {
  const fake = api();
  const catalog = await collectScopedCatalog(fake, { kind: "unassigned", days: 14 }, () => NOW);
  assert.deepEqual(catalog.conversations.map((c) => c.conversationId).sort(), [ID1, ID3].sort());
  assert.deepEqual(catalog.projects, []);
});

test("the recent scope stops paging at the cutoff and drops conversations of unknown projects", async () => {
  const fake = api();
  const catalog = await collectScopedCatalog(fake, { kind: "recent", days: 7 }, () => NOW);
  assert.deepEqual(catalog.conversations.map((c) => [c.conversationId, c.projectName]).sort(),
    [[ID1, null], [ID2, "프로젝트 A"], [ID3, null]].sort());
  assert.equal(catalog.conversations.some((c) => c.conversationId === ID5), false);
});

test("the untidy scope reads newest first and stops after three consecutive standard titles, dropping those three", async () => {
  const fake = api();
  const items = [
    { id: ID1, title: "정리 안 된 제목", update_time: day(1), gizmo_id: null },
    { id: ID2, title: "표준 — 하나", update_time: day(2), gizmo_id: PA },
    { id: ID3, title: "표준 아님", update_time: day(3), gizmo_id: null },
    { id: ID4, title: "표준 — 둘", update_time: day(4), gizmo_id: null },
    { id: ID5, title: "표준 — 셋", update_time: day(5), gizmo_id: UNKNOWN },
    { id: "66666666-6666-4666-8666-666666666666", title: "표준 — 넷", update_time: day(6), gizmo_id: null },
    { id: "77777777-7777-4777-8777-777777777777", title: "표준 — 다섯", update_time: day(7), gizmo_id: null },
    { id: "88888888-8888-4888-8888-888888888888", title: "더 옛날 미정돈", update_time: day(8), gizmo_id: null },
  ];
  fake.listConversations = async ({ archived, offset, limit }) => {
    fake.calls.list.push({ archived, offset });
    return ok({ items: items.slice(offset, offset + limit), total: items.length, has_next: offset + limit < items.length });
  };
  const catalog = await collectScopedCatalog(fake, { kind: "untidy" }, () => NOW);
  // ID5(모르는 프로젝트)는 세지 않고, 표준 제목 3건(4·6·7번째)이 연달아 나온 자리에서 멈춘다. 그 3건은 후보에서 뺀다.
  assert.deepEqual(catalog.conversations.map((c) => c.conversationId).sort(), [ID1, ID2, ID3].sort());
  assert.equal(catalog.scope.complete, false);
  assert.deepEqual(catalog.scope.collected, { kind: "untidy" });
});

test("bodies saved by an earlier run are reused only while the conversation is unmodified", async () => {
  await withTemp("chatgpt-maintenance-reuse-", async (root) => {
    const old = join(root, "runs", "old-run", "json");
    mkdirSync(old, { recursive: true });
    const saved = (id, title, updateTime) => writeFileSync(join(old, `${id}.json`), JSON.stringify({ conversation_id: id, id, title, update_time: updateTime,
      mapping: { root: { id: "root", message: null }, one: { id: "one", message: { content: { parts: ["예전"] }, metadata: {} } } } }));
    saved(ID1, "미배치 — 하나", Date.parse(day(1)) / 1000 + 0.2); // 목록과 같은 상태(0.2초 어긋남)
    saved(ID3, "사용자 정의 GPT — 대화", Date.parse(day(3)) / 1000 - 3600); // 그 뒤 수정됨
    const fake = api();
    const fetched = [];
    const body = fake.getConversation;
    fake.getConversation = async (id) => { fetched.push(id); return body(id); };
    const reused = [];
    const dirs = reusableBodyDirs(root, join(root, "runs", "new-run"));
    assert.deepEqual(dirs, [old], "the current run is never its own source");
    const result = await scanMaintenanceRun({ runDir: join(root, "runs", "new-run"), api: fake, scope: { kind: "unassigned" }, reuseDirs: dirs, now: () => NOW,
      onReuse: (item) => reused.push(item.conversationId) });
    assert.deepEqual(reused, [ID1]);
    assert.deepEqual(fetched.sort(), [ID3, ID4].sort(), "the modified and the missing conversation are downloaded");
    assert.equal(result.inventory.counts.candidates, 3);
    assert.equal(JSON.parse(readFileSync(join(root, "runs", "new-run", "json", `${ID1}.json`), "utf8")).mapping.one.message.content.parts[0], "예전", "the reused body is copied into the new run");
  });
});

test("a title that changed between the list and the body is adopted instead of aborting the scan", async () => {
  await withTemp("chatgpt-maintenance-retitle-", async (root) => {
    const fake = api();
    const body = fake.getConversation;
    fake.getConversation = async (id) => { const res = await body(id); if (id === ID1) res.data.title = "ChatGPT가 새로 붙인 제목"; return res; };
    const result = await scanMaintenanceRun({ runDir: join(root, "run"), api: fake, scope: { kind: "unassigned" }, now: () => NOW });
    assert.equal(result.inventory.counts.candidates, 3);
    assert.equal(result.inventory.conversations.find((c) => c.conversationId === ID1).title, "ChatGPT가 새로 붙인 제목");
  });
});

test("skipFailed skips a conversation that keeps failing after four tries and records it; without it the scan stops", async () => {
  await withTemp("chatgpt-maintenance-skip-", async (root) => {
    const fake = api();
    const body = fake.getConversation;
    const seen = [];
    fake.getConversation = async (id, options = {}) => {
      seen.push([id, options.tries ?? null]);
      return id === ID3 ? { ok: false, status: 599 } : body(id);
    };
    await assert.rejects(() => scanMaintenanceRun({ runDir: join(root, "strict"), api: fake, scope: { kind: "unassigned" }, now: () => NOW }), /HTTP 599/);
    assert.equal(seen.every(([, tries]) => tries === null), true, "the default keeps the relay's own retry limit");

    seen.length = 0;
    const skippedEvents = [];
    const result = await scanMaintenanceRun({ runDir: join(root, "skip"), api: fake, scope: { kind: "unassigned" }, skipFailed: true, now: () => NOW,
      onSkip: (item) => skippedEvents.push(item.conversationId) });
    assert.equal(seen.every(([, tries]) => tries === 4), true);
    assert.deepEqual(result.inventory.skipped, [{ conversationId: ID3, title: "사용자 정의 GPT — 대화", status: 599 }]);
    assert.deepEqual(skippedEvents, [ID3]);
    assert.equal(result.inventory.counts.candidates, 2, "the skipped conversation is not a candidate");
    assert.deepEqual(result.inventory.warnings, [], "skipping does not make the inventory unusable");
  });
});

test("skipStandardTitles downloads only conversations whose title is not standard and counts the others", async () => {
  await withTemp("chatgpt-maintenance-standard-", async (root) => {
    const fake = api();
    const items = [
      { id: ID1, title: "정리 안 된 제목", update_time: day(1), gizmo_id: null },
      { id: ID3, title: "표준 — 제목", update_time: day(3), gizmo_id: null },
      { id: ID4, title: "또 안 된 제목", update_time: day(5), gizmo_id: null },
    ];
    fake.listConversations = async ({ archived, offset, limit }) => ok({ items: items.slice(offset, offset + limit), total: items.length, has_next: false });
    const fetched = [];
    const body = fake.getConversation;
    fake.getConversation = async (id) => { fetched.push(id); const res = await body(id); res.data.title = items.find((item) => item.id === id).title; return res; };
    const result = await scanMaintenanceRun({ runDir: join(root, "run"), api: fake, scope: { kind: "unassigned" }, skipStandardTitles: true, now: () => NOW });
    assert.deepEqual(fetched, [ID1, ID4], "the standard-titled conversation is never downloaded");
    assert.equal(result.inventory.counts.candidates, 2);
    assert.equal(result.inventory.standardTitlesExcluded, 1);

    // 제목 변경을 해제해 둔 대화는 제목이 그대로인 동안만 제외한다.
    const kept = await scanMaintenanceRun({ runDir: join(root, "run-kept"), api: fake, scope: { kind: "unassigned" }, skipStandardTitles: true, now: () => NOW,
      keptTitles: new Map([[ID1, "정리 안 된 제목"], [ID4, "예전 제목"]]) });
    assert.deepEqual(kept.inventory.conversations.map((c) => c.conversationId), [ID4], "ID1 is kept as is; ID4 was renamed since, so it is a candidate again");
    assert.equal(kept.inventory.standardTitlesExcluded, 2);

    const all = await scanMaintenanceRun({ runDir: join(root, "run2"), api: fake, scope: { kind: "unassigned" }, now: () => NOW });
    assert.equal(all.inventory.counts.candidates, 3);
    assert.equal("standardTitlesExcluded" in all.inventory, false, "the option is off by default");
  });
});

test("kept titles are read from the reviewed decisions of every run", async () => {
  await withTemp("chatgpt-maintenance-kept-", async (dataDir) => {
    mkdirSync(join(dataDir, "runs", "one"), { recursive: true });
    mkdirSync(join(dataDir, "runs", "broken"), { recursive: true });
    writeFileSync(join(dataDir, "runs", "one", "reviewed-decisions.json"), JSON.stringify({ decisions: [
      { conversationId: ID1, decision: "keep", newTitle: "그대로 둔 제목", keepTitle: true }, { conversationId: ID2, decision: "keep", newTitle: "바꾼 제목 — 결과" }] }));
    writeFileSync(join(dataDir, "runs", "broken", "reviewed-decisions.json"), "{ 깨짐");
    assert.deepEqual([...keptTitleMap(dataDir)], [[ID1, "그대로 둔 제목"]]);
    assert.equal(keptTitleMap(join(dataDir, "missing")).size, 0);
  });
});

test("an interrupted scan can be finished with only the bodies already downloaded", async () => {
  await withTemp("chatgpt-maintenance-partial-test-", async (root) => {
    const fake = api();
    let downloads = 0;
    const realGet = fake.getConversation;
    fake.getConversation = async (id) => {
      if (++downloads === 3) throw new Error("연결 끊김");
      return realGet(id);
    };
    const runDir = join(root, "run");
    await assert.rejects(() => scanMaintenanceRun({ runDir, api: fake, scope: { kind: "unassigned" }, now: () => NOW }), /연결 끊김/);
    const draft = readScanDraft(runDir);
    assert.equal(draft.selected.length, 3);
    assert.equal(countDownloaded(runDir, draft), 2);

    const result = finishPartialScan({ runDir });
    assert.equal(result.inventory.counts.candidates, 2);
    assert.deepEqual(result.inventory.partial, { downloaded: 2, total: 3 });
    assert.deepEqual(result.inventory.warnings, []);
    assert.equal(readScanDraft(runDir), null, "a finished folder is no longer resumable");
    assert.throws(() => finishPartialScan({ runDir }), /끊긴 수집이 없습니다/);
  });
});
