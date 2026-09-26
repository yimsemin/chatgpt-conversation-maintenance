import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildAfterCatalog, finalizeMaintenanceRun } from "../src/finalize.js";
import { collectConversationCatalog, timeMilliseconds, unwrapSidebarGizmo } from "../src/catalog.js";
import { isNormalizedTitle } from "../src/title-rules.js";
import { scanMaintenanceRun } from "../src/scan.js";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";

function response(data) {
  return { ok: true, status: 200, data };
}

function conversation(id, title, updateTime, text = "hello", archived = false) {
  return {
    conversation_id: id,
    id,
    title,
    create_time: 1,
    update_time: updateTime,
    is_archived: archived,
    mapping: {
      root: { id: "root", message: null },
      one: { id: "one", message: { content: { parts: [text] }, metadata: {} } },
    },
  };
}

function catalog(conversations) {
  return {
    version: 1,
    kind: "conversation-maintenance-catalog",
    generatedAt: "2026-08-10T00:00:00.000Z",
    scope: { activeConversations: true, archivedConversations: true, projectDiscovery: "owned_only", complete: true },
    counts: {
      conversations: conversations.length,
      active: conversations.filter((item) => !item.isArchived).length,
      archived: conversations.filter((item) => item.isArchived).length,
      unassigned: conversations.filter((item) => !item.projectName).length,
      projects: 0,
    },
    projects: [],
    conversations,
  };
}

function catalogItem(data, projectName = null) {
  return {
    conversationId: data.conversation_id,
    title: data.title,
    createTime: data.create_time,
    updateTime: data.update_time,
    isArchived: data.is_archived === true,
    projectName,
  };
}

function catalogApi({ active = [], archived = [], projects = [], projectConversations = {}, details = {} }) {
  const getJson = async (path) => {
    if (path.startsWith("gizmos/snorlax/sidebar?")) {
      return response({ items: projects.map((project) => ({ id: project.id, display: { name: project.name } })) });
    }
    const projectMatch = path.match(/^gizmos\/(g-p-[^/]+)\/conversations\?/);
    if (projectMatch) return response({ items: projectConversations[projectMatch[1]] || [] });
    if (path.includes("is_archived=false")) return response({ items: active, total: active.length, has_next: false });
    if (path.includes("is_archived=true")) return response({ items: archived, total: archived.length, has_next: false });
    throw new Error(`Unexpected path: ${path}`);
  };
  return {
    getJson,
    listProjectSidebar: ({ cursor = "", limit = 20 } = {}) => getJson(
      `gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0&limit=${limit}`
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "")),
    listProjectConversations: (projectId, { cursor = "", limit = 50 } = {}) => getJson(
      `gizmos/${encodeURIComponent(projectId)}/conversations?limit=${limit}`
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "")),
    listConversations: ({ archived = false, offset = 0, limit = 100 } = {}) => getJson(
      `conversations?offset=${offset}&limit=${limit}&is_archived=${archived === true}`),
    getConversation: async (id) => response(details[id]),
  };
}

test("normalized titles require one exact spaced em dash separator", () => {
  assert.equal(isNormalizedTitle("대상 — 실제 작업"), true);
  assert.equal(isNormalizedTitle("대상—실제 작업"), false);
  assert.equal(isNormalizedTitle("대상 — 작업 — 결과"), false);
  assert.equal(isNormalizedTitle("단일 제목"), false);
  assert.equal(isNormalizedTitle(" 대상 — 실제 작업 "), false);
});

test("catalog covers all conversations and keeps project context for empty projects", async () => {
  const active = conversation(ID1, "활성 — 대화", 2);
  const archived = conversation(ID2, "보관 — 대화", 3, "archived", true);
  const projectOnly = conversation(ID3, "프로젝트 — 대화", 4);
  const api = catalogApi({
    active: [active],
    archived: [archived],
    projects: [
      { id: "g-p-one", name: "Project A" },
      { id: "g-p-empty", name: "Empty Project" },
    ],
    projectConversations: { "g-p-one": [projectOnly] },
  });
  const result = await collectConversationCatalog(api, () => new Date("2026-08-10T00:00:00Z"));
  assert.equal(result.counts.conversations, 3);
  assert.equal(result.counts.archived, 1);
  assert.equal(result.counts.projects, 2);
  assert.equal(result.conversations.find((item) => item.conversationId === ID3).projectName, "Project A");
  assert.deepEqual(result.projects, [
    { projectName: "Empty Project", conversationCount: 0, sampleTitles: [] },
    { projectName: "Project A", conversationCount: 1, sampleTitles: ["프로젝트 — 대화"] },
  ]);
});


test("scan preserves title whitespace so exact backup checks can classify it", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-maintenance-title-whitespace-test-"));
  try {
    const current = conversation(ID1, "줄바꿈 제목\n", 2);
    const result = await scanMaintenanceRun({
      runDir: join(root, "run"),
      api: catalogApi({ active: [current], details: { [ID1]: current } }),
      scope: { kind: "all" },
      now: () => new Date("2026-08-10T00:00:00Z"),
    });
    assert.equal(result.inventory.conversations[0].title, "줄바꿈 제목\n");
    assert.deepEqual(result.inventory.conversations[0].reasons, ["scope"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function finalizeFixture(root, currents, decisions, { source = { mode: "scope", scope: { kind: "all" } } } = {}) {
  const beforeCatalog = catalog(currents.map((item) => catalogItem(item, null)));
  beforeCatalog.projects = [{ projectName: "Project A", conversationCount: 0, sampleTitles: [] }];
  const catalogPath = join(root, "catalog.json");
  writeFileSync(catalogPath, JSON.stringify(beforeCatalog));
  const inventoryPath = join(root, "inventory.json");
  writeFileSync(inventoryPath, JSON.stringify({
    version: 1,
    kind: "conversation-maintenance-inventory",
    warnings: [],
    runRoot: root,
    catalogFile: catalogPath,
    source,
    conversations: currents.map((item) => ({ ...catalogItem(item, null), backupFile: "x", backupSha256: "x" })),
  }));
  const inventoryDigest = createHash("sha256").update(readFileSync(inventoryPath)).digest("hex");
  const decisionsPath = join(root, "decisions.json");
  writeFileSync(decisionsPath, JSON.stringify({ version: 1, kind: "reviewed-decisions", inventoryDigest, decisions }));
  return { inventoryPath, decisionsPath };
}

test("finalize builds the run's result catalog only when every candidate was reviewed", () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-maintenance-finalize-test-"));
  try {
    const current = conversation(ID1, "대상 — 작업", 2);
    const files = finalizeFixture(root, [current], [{ conversationId: ID1, decision: "keep", projectName: "Project A", reviewed: true }]);
    const result = finalizeMaintenanceRun({ ...files, now: () => new Date("2026-08-10T00:00:00Z") });
    assert.equal(result.afterCatalog.conversations[0].projectName, "Project A");
    assert.equal(result.afterCatalog.projects.find((p) => p.projectName === "Project A").conversationCount, 1);
    assert.equal(JSON.parse(readFileSync(join(root, "after-catalog.json"))).counts.conversations, 1);

    const other = conversation(ID2, "다른 — 작업", 3);
    const two = finalizeFixture(mkdtempSync(join(tmpdir(), "chatgpt-maintenance-finalize-test-")), [current, other],
      [{ conversationId: ID1, decision: "keep", reviewed: true }]);
    assert.throws(() => finalizeMaintenanceRun(two), /exactly one reviewed decision/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finalize rejects archive and unresolved decisions", () => {
  for (const decision of ["archive", "undecided"]) {
    const root = mkdtempSync(join(tmpdir(), "chatgpt-maintenance-invalid-decision-test-"));
    try {
      const current = conversation(ID1, "대상 — 작업 결과 정리", 2);
      const files = finalizeFixture(root, [current], [{ conversationId: ID1, decision, projectName: "Project A", reviewed: true }]);
      assert.throws(() => finalizeMaintenanceRun(files), /must be keep or delete/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("the result catalog drops deleted conversations, applies titles and moves, and never invents unread project counts", () => {
  const before = catalog([catalogItem(conversation(ID1, "가 — 작업", 2)), catalogItem(conversation(ID2, "나 — 작업", 3), "Read"),
    catalogItem(conversation(ID3, "삭제될 대화", 4))]);
  before.scope = { ...before.scope, complete: false };
  before.projects = [{ projectName: "Read", conversationCount: 1, sampleTitles: [] }, { projectName: "Unread", conversationCount: null, sampleTitles: [] }];
  const after = buildAfterCatalog(before, [
    { conversationId: ID1, decision: "keep", newTitle: "새 제목 — 결과", projectName: "Unread" },
    { conversationId: ID2, decision: "keep" },
    { conversationId: ID3, decision: "delete" },
  ], () => new Date("2026-08-11T00:00:00Z"));
  assert.deepEqual(after.conversations.map((c) => [c.conversationId, c.title, c.projectName]),
    [[ID1, "새 제목 — 결과", "Unread"], [ID2, "나 — 작업", "Read"]]);
  assert.deepEqual(after.projects.map((p) => [p.projectName, p.conversationCount]), [["Read", 1], ["Unread", null]]);
  assert.equal(after.counts.conversations, 2);
});

test("timestamps compare equal across ISO strings and float epoch seconds, and unknown ones are null", () => {
  const iso = "2026-08-27T15:18:23.211721Z";
  assert.equal(timeMilliseconds(iso), timeMilliseconds(Date.parse(iso) / 1000 + 0.000721));
  assert.notEqual(timeMilliseconds(iso), timeMilliseconds("2026-08-27T15:18:23.212Z"));
  for (const unknown of [null, undefined, "", "not a time"]) assert.equal(timeMilliseconds(unknown), null);
});

test("sidebar entries are unwrapped at every observed nesting depth", () => {
  const gizmo = { id: `g-p-${"a".repeat(32)}`, display: { name: "조사" } };
  assert.deepEqual(unwrapSidebarGizmo(gizmo), gizmo);
  assert.deepEqual(unwrapSidebarGizmo({ gizmo }), gizmo);
  assert.deepEqual(unwrapSidebarGizmo({ resource: { gizmo } }), gizmo);
  assert.deepEqual(unwrapSidebarGizmo({ gizmo: { gizmo } }), gizmo);
  assert.deepEqual(unwrapSidebarGizmo({ resource: { gizmo: { gizmo } } }), gizmo);
  // 감싸지 않은 잘못된 입력도 빈 객체로 안전하게 돌려준다.
  assert.deepEqual(unwrapSidebarGizmo(null), {});
  assert.deepEqual(unwrapSidebarGizmo("x"), {});
});

test("a full scan downloads every conversation and resumes without refetching", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-maintenance-full-test-"));
  try {
    const current = conversation(ID1, "대상 — 작업", 2);
    const api = catalogApi({
      active: [current],
      projects: [{ id: "g-p-one", name: "Project A" }],
      projectConversations: { "g-p-one": [current] },
      details: { [ID1]: current },
    });
    let fetched = 0;
    const counting = { ...api, getConversation: (id) => { fetched += 1; return api.getConversation(id); } };
    const runDir = join(root, "run");
    const options = { runDir, api: counting, scope: { kind: "all" }, now: () => new Date("2026-08-10T00:00:00Z") };
    // 앞선 실행이 본문만 받고 끊긴 상태를 만든다.
    await scanMaintenanceRun(options);
    assert.equal(fetched, 1);
    rmSync(join(runDir, "inventory.json"));
    rmSync(join(runDir, "catalog.json"));
    const result = await scanMaintenanceRun(options);
    assert.equal(fetched, 1);
    assert.equal(result.inventory.counts.candidates, 1);
    assert.equal(result.inventory.source.mode, "scope");
    assert.deepEqual(result.inventory.source.scope, { kind: "all" });
    assert.deepEqual(result.inventory.conversations[0].reasons, ["scope"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
