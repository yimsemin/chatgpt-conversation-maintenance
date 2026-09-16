import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  catalogItemDifferences,
  checkpointMaintenanceRun,
  describeMetadataDrift,
  sameTime,
  timeMilliseconds,
  unwrapSidebarGizmo,
  collectConversationCatalog,
  diagnoseReadAccess,
  isNormalizedTitle,
  scanMaintenanceRun,
  seedMaintenanceRun,
  selectMaintenanceCandidates,
  synchronizeMaintenanceStateAfterProjectRouting,
} from "../maintenance-cli.js";
import { holdEntry, readHoldList, writeHoldList } from "../hold-list.js";
import { projectRoutingStatus } from "../project-routing.js";

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
    scope: { activeConversations: true, archivedConversations: true, projectDiscovery: "owned_only" },
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
    const statePath = join(root, "state.json");
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      kind: "conversation-maintenance-state",
      conversations: [],
    }));
    const result = await scanMaintenanceRun({
      statePath,
      runDir: join(root, "run"),
      api: catalogApi({ active: [current], details: { [ID1]: current } }),
      now: () => new Date("2026-08-10T00:00:00Z"),
    });
    assert.equal(result.inventory.conversations[0].title, "줄바꿈 제목\n");
    assert.deepEqual(result.inventory.conversations[0].reasons,
      ["new", "project-required", "title-format"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate selection reads only new, changed, projectless, or nonconforming conversations", () => {
  const previous = catalogItem(conversation(ID1, "대상 — 작업", 2), "Project A");
  const unchanged = { ...previous };
  const updated = catalogItem(conversation(ID2, "다른 대상 — 작업", 3), "Project A");
  const invalid = catalogItem(conversation(ID3, "단일 제목", 1));
  const state = {
    version: 1,
    kind: "conversation-maintenance-state",
    conversations: [previous, { ...updated, updateTime: 2 }, invalid],
  };
  const selected = selectMaintenanceCandidates(state, catalog([unchanged, updated, invalid]));
  assert.deepEqual(selected.candidates.map((item) => item.conversationId), [ID2, ID3]);
  assert.deepEqual(selected.candidates[0].reasons, ["updated"]);
  assert.deepEqual(selected.candidates[1].reasons, ["project-required", "title-format"]);
});

test("a format-only candidate is suppressed while on a matching hold list and released by any change", () => {
  const held = catalogItem(conversation(ID1, "단일 제목", 2), "Project A");
  const state = {
    version: 1,
    kind: "conversation-maintenance-state",
    conversations: [{ ...held }],
  };

  const without = selectMaintenanceCandidates(state, catalog([held]));
  assert.deepEqual(without.candidates.map((item) => item.conversationId), [ID1]);
  assert.deepEqual(without.candidates[0].reasons, ["title-format"]);

  const holdList = { conversations: [holdEntry(held)] };
  const suppressed = selectMaintenanceCandidates(state, catalog([held]), holdList);
  assert.deepEqual(suppressed.candidates, []);
  assert.deepEqual(suppressed.suppressedByHoldIds, [ID1]);

  const changed = catalogItem(conversation(ID1, "단일 제목", 3), "Project A");
  const released = selectMaintenanceCandidates(
    { ...state, conversations: [{ ...held }] },
    catalog([changed]),
    holdList,
  );
  assert.deepEqual(released.candidates.map((item) => item.conversationId), [ID1]);
  assert.equal(released.candidates[0].reasons.includes("updated"), true);
  assert.deepEqual(released.suppressedByHoldIds, []);
});

test("a format-only candidate is proposed once, then parked on the hold list for later scans", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-maintenance-hold-test-"));
  try {
    const current = conversation(ID1, "단일 제목", 2);
    const api = () => catalogApi({
      active: [current],
      projects: [{ id: "g-p-one", name: "Project A" }],
      projectConversations: { "g-p-one": [current] },
      details: { [ID1]: current },
    });
    const statePath = join(root, "state.json");
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      kind: "conversation-maintenance-state",
      conversations: [catalogItem(current, "Project A")],
    }));

    const first = await scanMaintenanceRun({
      statePath,
      runDir: join(root, "run-1"),
      api: api(),
      now: () => new Date("2026-08-10T00:00:00Z"),
    });
    assert.equal(first.inventory.counts.candidates, 1);
    assert.deepEqual(first.inventory.conversations[0].reasons, ["title-format"]);
    assert.deepEqual(readHoldList(root).conversations.map((item) => item.conversationId), [ID1]);

    const second = await scanMaintenanceRun({
      statePath,
      runDir: join(root, "run-2"),
      api: api(),
      now: () => new Date("2026-08-11T00:00:00Z"),
    });
    assert.equal(second.inventory.counts.candidates, 0);
    assert.equal(second.inventory.counts.held, 1);
    assert.deepEqual(second.inventory.heldConversationIds, [ID1]);
    assert.equal(second.checkpointAdvanced, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scan prunes a hold entry once the conversation reappears as a candidate", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-maintenance-hold-prune-test-"));
  try {
    const current = conversation(ID1, "단일 제목", 5);
    const statePath = join(root, "state.json");
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      kind: "conversation-maintenance-state",
      conversations: [{ ...catalogItem(current, "Project A"), updateTime: 2 }],
    }));
    writeHoldList(root, { conversations: [holdEntry({ ...catalogItem(current, "Project A"), updateTime: 2 })] });
    const result = await scanMaintenanceRun({
      statePath,
      runDir: join(root, "run"),
      api: catalogApi({ active: [current], projects: [{ id: "g-p-one", name: "Project A" }], projectConversations: { "g-p-one": [current] }, details: { [ID1]: current } }),
      now: () => new Date("2026-08-12T00:00:00Z"),
    });
    assert.equal(result.inventory.counts.candidates, 1);
    assert.equal(result.inventory.conversations[0].reasons.includes("updated"), true);
    assert.deepEqual(readHoldList(root).conversations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seed accepts the completed cleanup as baseline and downloads only new or invalid-title candidates", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-maintenance-seed-test-"));
  try {
    const previousDir = join(root, "previous");
    mkdirSync(previousDir);
    const previousBackup = join(previousDir, `${ID1}.json`);
    const old = conversation(ID1, "이전 제목", 1, "same");
    writeFileSync(previousBackup, JSON.stringify(old));
    const previousInventory = join(root, "previous-inventory.json");
    writeFileSync(previousInventory, JSON.stringify({
      version: 1,
      kind: "conversation-inventory",
      warnings: [],
      conversations: [{
        conversationId: ID1,
        backupFile: previousBackup,
        backupSha256: createHash("sha256").update(readFileSync(previousBackup)).digest("hex"),
      }],
    }));
    const sameContent = conversation(ID1, "대상 — 작업", 5, "changed after export but already reviewed");
    const newlyCreated = conversation(ID2, "새 대화", 6, "new");
    const api = catalogApi({
      active: [sameContent, newlyCreated],
      projects: [{ id: "g-p-one", name: "Project A" }],
      projectConversations: { "g-p-one": [sameContent] },
      details: { [ID1]: sameContent, [ID2]: newlyCreated },
    });
    let downloads = 0;
    const getConversation = api.getConversation;
    api.getConversation = async (id) => {
      downloads++;
      return getConversation(id);
    };
    const result = await seedMaintenanceRun({
      previousInventoryPath: previousInventory,
      runDir: join(root, "run"),
      api,
      now: () => new Date("2026-08-10T00:00:00Z"),
    });
    assert.equal(result.inventory.counts.catalogConversations, 2);
    assert.equal(result.inventory.counts.candidates, 1);
    assert.deepEqual(result.inventory.projects, [{
      projectName: "Project A",
      conversationCount: 1,
      sampleTitles: ["대상 — 작업"],
    }]);
    assert.equal(result.inventory.conversations[0].conversationId, ID2);
    assert.deepEqual(result.inventory.conversations[0].reasons,
      ["new", "project-required", "title-format"]);
    assert.equal(downloads, 1);
    assert.equal(existsSync(join(root, "run", "all-inventory.json")), false);
    assert.equal(result.inventory.source.baselinePolicy,
      "accept-current-catalog-after-completed-cleanup");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seed can continue from a prior catalog after a concurrent conversation appears", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-maintenance-followup-seed-test-"));
  try {
    const known = conversation(ID1, "대상 — 작업", 2);
    const previousCatalog = join(root, "catalog.json");
    writeFileSync(previousCatalog, JSON.stringify(catalog([catalogItem(known)])));
    const newlyCreated = conversation(ID2, "후속 대화", 3, "new");
    const api = catalogApi({
      active: [known, newlyCreated],
      projects: [{ id: "g-p-one", name: "Project A" }],
      projectConversations: { "g-p-one": [known] },
      details: { [ID2]: newlyCreated },
    });
    const result = await seedMaintenanceRun({
      previousInventoryPath: previousCatalog,
      runDir: join(root, "run"),
      api,
      now: () => new Date("2026-08-10T00:00:00Z"),
    });
    assert.equal(result.inventory.counts.candidates, 1);
    assert.equal(result.inventory.conversations[0].conversationId, ID2);
    assert.equal(result.inventory.source.previousBaselineKind,
      "conversation-maintenance-catalog");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty recurring scan advances the lightweight checkpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-maintenance-scan-test-"));
  try {
    const current = conversation(ID1, "대상 — 작업", 2);
    const item = catalogItem(current, "Project A");
    const statePath = join(root, "state.json");
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      kind: "conversation-maintenance-state",
      conversations: [item],
    }));
    const api = catalogApi({
      active: [current],
      projects: [
        { id: "g-p-one", name: "Project A" },
        { id: "g-p-empty", name: "Empty Project" },
      ],
      projectConversations: { "g-p-one": [current] },
      details: { [ID1]: current },
    });
    const result = await scanMaintenanceRun({
      statePath,
      runDir: join(root, "run"),
      api,
      now: () => new Date("2026-08-10T00:00:00Z"),
    });
    assert.equal(result.inventory.counts.candidates, 0);
    assert.equal(result.checkpointAdvanced, true);
    const state = JSON.parse(readFileSync(statePath));
    assert.equal(state.kind, "conversation-maintenance-state");
    assert.deepEqual(state.projects, [
      { projectName: "Empty Project", conversationCount: 0, sampleTitles: [] },
      { projectName: "Project A", conversationCount: 1, sampleTitles: ["대상 — 작업"] },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scan records a missing conversation only after a 404 confirmation", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-maintenance-missing-test-"));
  try {
    const missing = conversation(ID1, "대상 — 작업", 2);
    const statePath = join(root, "state.json");
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      kind: "conversation-maintenance-state",
      conversations: [catalogItem(missing, "Project A")],
    }));
    const api = catalogApi({});
    api.getConversation = async () => ({ ok: false, status: 404, data: null });
    const result = await scanMaintenanceRun({
      statePath,
      runDir: join(root, "run"),
      api,
      now: () => new Date("2026-08-10T00:00:00Z"),
    });
    assert.deepEqual(result.inventory.removedConversationIds, [ID1]);
    assert.deepEqual(result.inventory.confirmedUnavailableConversationIds, [ID1]);
    assert.equal(result.inventory.counts.confirmedUnavailable, 1);
    assert.deepEqual(result.inventory.warnings, []);
    assert.equal(result.checkpointAdvanced, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scan still blocks when a missing catalog conversation remains readable", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-maintenance-readable-missing-test-"));
  try {
    const missing = conversation(ID1, "대상 — 작업", 2);
    const statePath = join(root, "state.json");
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      kind: "conversation-maintenance-state",
      conversations: [catalogItem(missing, "Project A")],
    }));
    const result = await scanMaintenanceRun({
      statePath,
      runDir: join(root, "run"),
      api: catalogApi({ details: { [ID1]: missing } }),
      now: () => new Date("2026-08-10T00:00:00Z"),
    });
    assert.deepEqual(result.inventory.confirmedUnavailableConversationIds, []);
    assert.equal(result.inventory.warnings.length, 1);
    assert.equal(result.checkpointAdvanced, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkpoint advances only after every no-mutation candidate was reviewed", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-maintenance-checkpoint-test-"));
  try {
    const current = conversation(ID1, "대상 — 작업", 2);
    const beforeCatalog = catalog([catalogItem(current)]);
    const catalogPath = join(root, "catalog.json");
    writeFileSync(catalogPath, JSON.stringify(beforeCatalog));
    const backupPath = join(root, `${ID1}.json`);
    const raw = Buffer.from(JSON.stringify(current));
    writeFileSync(backupPath, raw);
    const inventoryPath = join(root, "inventory.json");
    writeFileSync(inventoryPath, JSON.stringify({
      version: 1,
      kind: "conversation-maintenance-inventory",
      warnings: [],
      catalogFile: catalogPath,
      source: { mode: "seed" },
      conversations: [{
        ...catalogItem(current),
        backupFile: backupPath,
        backupSha256: createHash("sha256").update(raw).digest("hex"),
      }],
    }));
    const inventoryDigest = createHash("sha256").update(readFileSync(inventoryPath)).digest("hex");
    const decisionsPath = join(root, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify({
      version: 1,
      kind: "reviewed-decisions",
      inventoryDigest,
      decisions: [{
        conversationId: ID1,
        decision: "keep",
        projectName: "Project A",
        reviewed: true,
      }],
    }));
    const api = catalogApi({ active: [current], details: { [ID1]: current } });
    const statePath = join(root, "state.json");
    const result = await checkpointMaintenanceRun({
      inventoryPath,
      decisionsPath,
      statePath,
      api,
      now: () => new Date("2026-08-10T00:00:00Z"),
    });
    assert.equal(result.state.counts.conversations, 1);
    assert.equal(JSON.parse(readFileSync(statePath)).conversations[0].title, "대상 — 작업");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function movePlanFixture(root, { liveProjectName }) {
  const current = conversation(ID1, "대상 — 작업", 2);
  const beforeCatalog = catalog([catalogItem(current, "Project A")]);
  const catalogPath = join(root, "catalog.json");
  writeFileSync(catalogPath, JSON.stringify(beforeCatalog));
  const inventoryPath = join(root, "inventory.json");
  writeFileSync(inventoryPath, JSON.stringify({
    version: 1,
    kind: "conversation-maintenance-inventory",
    warnings: [],
    catalogFile: catalogPath,
    source: { mode: "manual-reorg" },
    conversations: [catalogItem(current, "Project A")],
  }));
  const inventoryDigest = createHash("sha256").update(readFileSync(inventoryPath)).digest("hex");
  const decisionsPath = join(root, "decisions.json");
  writeFileSync(decisionsPath, JSON.stringify({
    version: 1,
    kind: "reviewed-decisions",
    inventoryDigest,
    decisions: [{
      conversationId: ID1,
      decision: "keep",
      projectName: "Project B",
      reviewed: true,
    }],
  }));
  const liveConversation = conversation(ID1, "대상 — 작업", 2);
  const projects = [{ id: "g-p-a", name: "Project A" }, { id: "g-p-b", name: "Project B" }, { id: "g-p-c", name: "Project C" }];
  const projectIdByName = { "Project A": "g-p-a", "Project B": "g-p-b", "Project C": "g-p-c" };
  const api = catalogApi({
    active: [liveConversation],
    details: { [ID1]: liveConversation },
    projects,
    projectConversations: { [projectIdByName[liveProjectName]]: [liveConversation] },
  });
  return { inventoryPath, decisionsPath, statePath: join(root, "state.json"), api };
}

test("checkpoint tolerates a planned project move whether or not it already happened", async () => {
  for (const liveProjectName of ["Project A", "Project B"]) {
    const root = mkdtempSync(join(tmpdir(), "chatgpt-maintenance-move-checkpoint-test-"));
    try {
      const { inventoryPath, decisionsPath, statePath, api } = movePlanFixture(root, { liveProjectName });
      const result = await checkpointMaintenanceRun({
        inventoryPath, decisionsPath, statePath, api,
        now: () => new Date("2026-08-10T00:00:00Z"),
      });
      assert.equal(result.state.conversations[0].projectName, liveProjectName);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("checkpoint still rejects a planned move landing somewhere unexpected", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-maintenance-move-checkpoint-bad-test-"));
  try {
    const { inventoryPath, decisionsPath, statePath, api } = movePlanFixture(root, { liveProjectName: "Project C" });
    await assert.rejects(
      checkpointMaintenanceRun({ inventoryPath, decisionsPath, statePath, api }),
      /Conversation changed unexpectedly during maintenance/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("maintenance checkpoint rejects archive and unresolved decisions", async () => {
  for (const decision of ["archive", "undecided"]) {
    const root = mkdtempSync(join(tmpdir(), "chatgpt-maintenance-invalid-decision-test-"));
    try {
      const current = conversation(ID1, "대상 — 작업 결과 정리", 2);
      const beforeCatalog = catalog([catalogItem(current)]);
      const catalogPath = join(root, "catalog.json");
      writeFileSync(catalogPath, JSON.stringify(beforeCatalog));
      const inventoryPath = join(root, "inventory.json");
      writeFileSync(inventoryPath, JSON.stringify({
        version: 1,
        kind: "conversation-maintenance-inventory",
        warnings: [],
        catalogFile: catalogPath,
        source: { mode: "seed" },
        conversations: [catalogItem(current)],
      }));
      const inventoryDigest = createHash("sha256").update(readFileSync(inventoryPath)).digest("hex");
      const decisionsPath = join(root, "decisions.json");
      writeFileSync(decisionsPath, JSON.stringify({
        version: 1,
        kind: "reviewed-decisions",
        inventoryDigest,
        decisions: [{
          conversationId: ID1,
          decision,
          projectName: "Project A",
          reviewed: true,
        }],
      }));

      await assert.rejects(
        checkpointMaintenanceRun({
          inventoryPath,
          decisionsPath,
          statePath: join(root, "state.json"),
          api: catalogApi({ active: [current] }),
        }),
        /Unsupported reviewed decision/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("routing synchronization accepts only receipt-proven moves without unrelated drift", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-maintenance-routing-sync-test-"));
  try {
    const receipts = join(root, "receipts");
    mkdirSync(receipts);
    const routed = conversation(ID1, "대상 — 작업", 3);
    const routing = {
      version: 1,
      kind: "chatgpt-project-routing",
      workspace: "business",
      receiptDir: receipts,
      targets: [{
        project: {
          name: "Project A",
          instructions: "",
          projectId: `g-p-${"1".repeat(32)}`,
          createIfMissing: false,
          approved: true,
        },
        actions: [{
          conversationId: ID1,
          expectedTitle: routed.title,
          expectedSourceProjectId: null,
          approved: true,
        }],
      }],
    };
    const routingPath = join(root, "routing.json");
    writeFileSync(routingPath, JSON.stringify(routing));
    const planDigest = projectRoutingStatus(routing).targets[0].planDigest;
    writeFileSync(join(receipts, "completed.json"), JSON.stringify({
      kind: "chatgpt-project-placement-receipt",
      status: "completed",
      planDigest,
      results: [{ type: "move-conversation", conversationId: ID1, ok: true }],
    }));

    const stable = conversation(ID2, "기존 — 작업", 2);
    const drifted = conversation(ID2, "변경 — 작업", 2);
    const unsafeStatePath = join(root, "unsafe-state.json");
    const unsafeState = {
      version: 1,
      kind: "conversation-maintenance-state",
      conversations: [catalogItem(routed), catalogItem(stable, "Project B")],
    };
    const unsafeRaw = JSON.stringify(unsafeState);
    writeFileSync(unsafeStatePath, unsafeRaw);
    const unsafeApi = catalogApi({
      active: [routed, drifted],
      projects: [
        { id: `g-p-${"1".repeat(32)}`, name: "Project A" },
        { id: `g-p-${"2".repeat(32)}`, name: "Project B" },
      ],
      projectConversations: {
        [`g-p-${"1".repeat(32)}`]: [routed],
        [`g-p-${"2".repeat(32)}`]: [drifted],
      },
    });
    await assert.rejects(
      synchronizeMaintenanceStateAfterProjectRouting({
        statePath: unsafeStatePath,
        routingPath,
        api: unsafeApi,
      }),
      /Unplanned conversation change/,
    );
    assert.equal(readFileSync(unsafeStatePath, "utf8"), unsafeRaw);

    const statePath = join(root, "state.json");
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      kind: "conversation-maintenance-state",
      conversations: [catalogItem(routed)],
    }));
    const api = catalogApi({
      active: [routed, stable],
      projects: [
        { id: `g-p-${"1".repeat(32)}`, name: "Project A" },
        { id: `g-p-${"2".repeat(32)}`, name: "Project B" },
      ],
      projectConversations: {
        [`g-p-${"1".repeat(32)}`]: [routed],
        [`g-p-${"2".repeat(32)}`]: [stable],
      },
    });
    const result = await synchronizeMaintenanceStateAfterProjectRouting({
      statePath,
      routingPath,
      api,
      now: () => new Date("2026-08-11T00:00:00Z"),
    });
    assert.equal(result.synchronizedConversations, 1);
    assert.equal(result.state.counts.unassigned, 0);
    assert.deepEqual(result.deferredNewConversationIds, [ID2]);
    assert.equal(result.state.counts.conversations, 1);
    assert.deepEqual(result.state.projects, [
      { projectName: "Project A", conversationCount: 1, sampleTitles: ["대상 — 작업"] },
      { projectName: "Project B", conversationCount: 0, sampleTitles: [] },
    ]);
    assert.equal(JSON.parse(readFileSync(statePath)).conversations[0].projectName, "Project A");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read diagnostics separate a working read from a failing endpoint", async () => {
  const api = {
    listConversations: async () => ({ ok: true, status: 200, data: { items: [{ id: "x" }] } }),
    listProjectSidebar: async () => ({
      ok: false,
      status: 403,
      data: { detail: { message: "Forbidden" } },
      contentType: "application/json",
      bodySnippet: '{"detail":{"message":"Forbidden"}}',
    }),
  };
  const { checks } = await diagnoseReadAccess({ api });
  assert.deepEqual(checks, [
    { name: "conversations", status: 200, ok: true, items: 1 },
    {
      name: "projects-sidebar",
      status: 403,
      ok: false,
      items: null,
      contentType: "application/json",
      detail: "Forbidden",
      bodySnippet: '{"detail":{"message":"Forbidden"}}',
    },
  ]);
});

test("read diagnostics record a thrown request without leaking the session", async () => {
  const api = {
    listConversations: async () => { throw new Error("network down"); },
    listProjectSidebar: async () => ({ ok: true, status: 200, data: { list: { items: [] } } }),
  };
  const { checks } = await diagnoseReadAccess({ api });
  assert.equal(checks[0].ok, false);
  assert.equal(checks[0].error, "network down");
  assert.deepEqual(checks[1], { name: "projects-sidebar", status: 200, ok: true, items: 0 });
});

// 드리프트 오류가 대화 ID만 알려주면 원격에서 무엇이 바뀐 것인지 알 수 없다(2026-09-12 실측).
test("metadata drift names the fields that changed without leaking their values", () => {
  const before = { conversationId: "c", title: "원래 제목", createTime: "2026-08-27T15:18:23.211721Z",
    updateTime: "2026-08-27T15:20:16.098138Z", isArchived: false, projectName: "AI 사용방법" };

  assert.equal(describeMetadataDrift(before, { ...before }), "");
  // 제목과 수정시각은 정상 변경이므로 드리프트로 보지 않는다.
  assert.equal(describeMetadataDrift(before, { ...before, title: "새 제목", updateTime: "2026-09-12T00:00:00Z" }), "");

  assert.equal(describeMetadataDrift(before, { ...before, isArchived: true }), "isArchived false -> true");
  // createTime 은 불변이고 수집 경로에 따라 다르게 보고되므로 변경 신호로 쓰지 않는다.
  assert.equal(describeMetadataDrift(before, { ...before, createTime: "2026-01-01T00:00:00Z" }), "");
  assert.equal(describeMetadataDrift(before, { ...before, projectName: null }),
    "projectName 프로젝트 있음 -> 프로젝트 없음");
  const moved = describeMetadataDrift(before, { ...before, projectName: "기밀프로젝트명" });
  assert.equal(moved, "projectName 변경(다른 프로젝트로 이동)");
  // 실제 프로젝트명은 오류 문구에 들어가지 않는다.
  assert.doesNotMatch(moved, /기밀프로젝트명/);
  assert.doesNotMatch(moved, /AI 사용방법/);

  assert.deepEqual(catalogItemDifferences(before, { ...before, title: "새 제목", isArchived: true }),
    ["title", "isArchived"]);
  // 같은 대화의 create_time 이 수집 경로에 따라 47초 차이로 보고된 실측 사례.
  assert.deepEqual(catalogItemDifferences(before,
    { ...before, createTime: "2026-08-27T15:19:10.998361Z" }), []);
});

// 같은 시각이 엔드포인트에 따라 ISO 문자열이나 epoch 초 실수로 온다. 표현 차이를
// 변경으로 오판하면 실제로 바뀌지 않은 대화 때문에 checkpoint 가 멈춘다(2026-09-12 실측).
test("the same instant compares equal across ISO strings and float epoch seconds", () => {
  const iso = "2026-08-27T15:18:23.211721Z";
  const epochSeconds = Date.parse(iso) / 1000 + 0.000721;
  assert.equal(timeMilliseconds(iso), timeMilliseconds(epochSeconds));
  assert.equal(sameTime(iso, epochSeconds), true);
  assert.equal(sameTime(epochSeconds, iso), true);
  // 밀리초 단위의 실제 차이는 계속 구분한다.
  assert.equal(sameTime(iso, "2026-08-27T15:18:23.212Z"), false);
});

test("an unknown timestamp is not treated as evidence of change", () => {
  const iso = "2026-08-27T15:18:23.211721Z";
  assert.equal(sameTime(iso, null), true);
  assert.equal(sameTime(null, iso), true);
  assert.equal(sameTime(undefined, iso), true);
  assert.equal(sameTime("", iso), true);
  assert.equal(sameTime(null, null), true);
  // 드리프트 판정도 알 수 없는 값으로는 실패하지 않는다.
  const before = { conversationId: "c", title: "t", createTime: iso, updateTime: iso,
    isArchived: false, projectName: "P" };
  assert.equal(describeMetadataDrift(before, { ...before, createTime: null }), "");
  assert.equal(describeMetadataDrift(before, { ...before, isArchived: true }), "isArchived false -> true");
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
})
