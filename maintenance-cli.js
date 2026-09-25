#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assert } from "./assert.js";
import { assertOptionalProjectName } from "./workflow.js";
import { attachmentReferenceCount, contentSha256, sha256, stableJson } from "./content-hash.js";
import { CONVERSATION_ID } from "./ids.js";
export { isNormalizedTitle } from "./title-rules.js";
import { isNormalizedTitle } from "./title-rules.js";
import { loadPlanSet } from "./management-cli.js";
import { resolveDataDir } from "./data-dir.js";
import { holdEntry, isHeld, readHoldList, writeHoldList } from "./hold-list.js";
import { assertLockHeld } from "./maintenance-lock.js";
import {
  projectRoutingDigest,
  projectRoutingStatus,
  validateProjectRouting,
} from "./project-routing.js";

try { process.umask(0o077); } catch {}

const MODULE_ROOT = dirname(fileURLToPath(import.meta.url));
const PAGE_SIZE = 100;
const PROJECT_PAGE_SIZE = 20;
const PROJECT_CONVERSATION_PAGE_SIZE = 50;

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`${label} is not valid JSON: ${path}`); }
}

function writeJsonNew(path, value) {
  assert(!existsSync(path), `Output already exists: ${path}`);
  writeJsonAtomic(path, value, "wx");
}

function writeJsonReplace(path, value) {
  writeJsonAtomic(path, value, "w");
}

function writeJsonAtomic(path, value, finalFlag) {
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.partial-${randomUUID()}`;
  try {
    writeFileSync(partial, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (finalFlag === "wx") assert(!existsSync(path), `Output already exists: ${path}`);
    renameSync(partial, path);
  } catch (error) {
    try { unlinkSync(partial); } catch {}
    throw error;
  }
}

function prepareRunDirectory(path, { resume = false } = {}) {
  const root = resolve(path);
  mkdirSync(root, { recursive: true });
  assert(statSync(root).isDirectory(), `Run path is not a directory: ${root}`);
  if (resume) {
    // 수집 도중 끊긴 실행만 이어받는다. 인벤토리까지 만든 실행은 다시 쓰지 않는다.
    assert(readdirSync(root).every((name) => name === "json"), `Run directory is not resumable: ${root}`);
    mkdirSync(join(root, "json"), { recursive: true });
    return root;
  }
  assert(readdirSync(root).length === 0, `Run directory is not empty: ${root}`);
  mkdirSync(join(root, "json"));
  return root;
}

// 같은 시각이 엔드포인트에 따라 ISO 문자열이나 epoch 초 실수로 오므로 정수 밀리초로 맞춘다.
// Date.parse 는 밀리초 아래를 버리므로 실수 쪽도 내림해야 같은 값이 된다.
export function timeMilliseconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value > 1e12 ? value : value * 1000);
  }
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

// 한쪽 시각을 알 수 없으면 "바뀌었다"로 보지 않는다. 대화 목록 엔드포인트는 항목을
// 수정시각 순으로 주고 offset 으로 페이지를 넘기므로, 제목을 대량 변경한 직후에는
// 일부 대화가 주 목록에서 밀려 프로젝트 목록에서만 수집된다. 그 응답에는 create_time 이
// 없을 수 있는데, 정보가 없는 것을 변경 증거로 취급하면 실제로 바뀌지 않은 대화 때문에
// 전체 작업이 멈춘다(2026-09-12 실측: createTime 드리프트로 checkpoint 2회 실패).
export function sameTime(left, right) {
  const a = timeMilliseconds(left);
  const b = timeMilliseconds(right);
  if (a === null || b === null) return true;
  return a === b;
}

function projectCatalog(projects, conversations) {
  return projects
    .map((project) => {
      const projectConversations = conversations
        .filter((conversation) => conversation.projectName === project.projectName)
        .sort((left, right) => {
          const timeDifference = (timeMilliseconds(right.updateTime) ?? 0)
            - (timeMilliseconds(left.updateTime) ?? 0);
          return timeDifference || left.conversationId.localeCompare(right.conversationId);
        });
      return {
        projectName: project.projectName,
        conversationCount: projectConversations.length,
        sampleTitles: projectConversations.slice(0, 5).map((conversation) => conversation.title),
      };
    })
    .sort((left, right) => left.projectName.localeCompare(right.projectName));
}

function unwrap(response, label) {
  assert(response.ok, `${label} failed: HTTP ${response.status}`);
  assert(response.data && typeof response.data === "object", `${label} returned invalid JSON`);
  return response.data;
}

// 사이드바 응답은 프로젝트를 여러 깊이로 감싸서 준다(`resource.gizmo`, `gizmo`, 또는 항목 자체).
// 관측된 래핑을 차례로 벗겨 가장 안쪽 객체를 돌려준다.
export function unwrapSidebarGizmo(entry) {
  let current = entry && typeof entry === "object" ? entry : {};
  for (let depth = 0; depth < 3; depth++) {
    const inner = current.resource?.gizmo ?? current.gizmo;
    if (!inner || typeof inner !== "object") break;
    current = inner;
  }
  return current;
}

export async function collectConversationCatalog(api, now = () => new Date(), onProgress = () => {}) {
  assert(api?.listProjectSidebar && api?.listProjectConversations && api?.listConversations,
    "Catalog API adapter is incomplete");
  onProgress({ phase: "projects", index: 0, total: null });
  const projects = [];
  let projectCursor = null;
  const seenProjectCursors = new Set();
  while (true) {
    const data = unwrap(
      await api.listProjectSidebar({ cursor: projectCursor || "", limit: PROJECT_PAGE_SIZE }),
      "Project discovery");
    const items = data.list?.items || data.items || [];
    if (!items.length) break;
    for (const entry of items) {
      const gizmo = unwrapSidebarGizmo(entry);
      const projectId = gizmo.id || "";
      if (!projectId.startsWith("g-p-")) continue;
      projects.push({
        projectId,
        projectName: gizmo.display?.name || gizmo.name || projectId,
      });
    }
    const next = data.list?.cursor || data.cursor || data.next_cursor || null;
    if (!next) break;
    assert(!seenProjectCursors.has(next), "Project pagination cursor repeated");
    seenProjectCursors.add(next);
    projectCursor = next;
  }

  const projectByConversation = new Map();
  const projectExtras = new Map();
  for (const [projectIndex, project] of projects.entries()) {
    onProgress({ phase: "projects", index: projectIndex, total: projects.length, projectName: project.projectName });
    let cursor = null;
    const seenCursors = new Set();
    while (true) {
      const data = unwrap(
        await api.listProjectConversations(project.projectId,
          { cursor: cursor || "", limit: PROJECT_CONVERSATION_PAGE_SIZE }),
        `Conversation discovery for project "${project.projectName}"`);
      const items = data.items || data.conversations || [];
      if (!items.length) break;
      for (const item of items) {
        if (!CONVERSATION_ID.test(item.id || "")) continue;
        projectByConversation.set(item.id, project.projectName);
        projectExtras.set(item.id, { ...item, projectName: project.projectName });
      }
      const next = data.list?.cursor || data.cursor || data.next_cursor || null;
      if (!next) break;
      assert(!seenCursors.has(next), `Conversation pagination cursor repeated for "${project.projectName}"`);
      seenCursors.add(next);
      cursor = next;
    }
  }

  const conversationById = new Map();
  for (const isArchived of [false, true]) {
    let offset = 0;
    const seenPages = new Set();
    while (true) {
      const data = unwrap(
        await api.listConversations({ archived: isArchived, offset, limit: PAGE_SIZE }),
        `${isArchived ? "Archived" : "Active"} conversation discovery`);
      const items = data.items || [];
      if (!items.length) break;
      const pageKey = `${items[0]?.id || ""}:${items.at(-1)?.id || ""}:${items.length}`;
      assert(!seenPages.has(pageKey), `Conversation pagination stalled at offset ${offset}`);
      seenPages.add(pageKey);
      for (const item of items) {
        if (!CONVERSATION_ID.test(item.id || "")) continue;
        conversationById.set(item.id, {
          ...item,
          is_archived: item.is_archived === true || isArchived,
          projectName: projectByConversation.get(item.id) || null,
        });
      }
      offset += items.length;
      const total = Number.isFinite(data.total) ? data.total : null;
      onProgress({ phase: isArchived ? "archived" : "active", index: offset, total });
      const hasNext = data.has_next ?? data.has_more;
      if (hasNext === false) break;
      if (hasNext !== true && total !== null && offset >= total) break;
      if (hasNext !== true && total === null && items.length < PAGE_SIZE) break;
    }
  }
  for (const [id, item] of projectExtras) {
    if (!conversationById.has(id)) conversationById.set(id, item);
  }

  const conversations = [...conversationById.values()].map((item) => ({
    conversationId: item.id,
    title: typeof item.title === "string" && item.title.trim() ? item.title : "Untitled",
    createTime: item.create_time ?? null,
    updateTime: item.update_time ?? null,
    isArchived: item.is_archived === true,
    projectName: item.projectName || projectByConversation.get(item.id) || null,
  })).sort((left, right) => left.conversationId.localeCompare(right.conversationId));
  const projectContext = projectCatalog(projects, conversations);

  return {
    version: 1,
    kind: "conversation-maintenance-catalog",
    generatedAt: now().toISOString(),
    scope: {
      activeConversations: true,
      archivedConversations: true,
      projectDiscovery: "owned_only",
    },
    counts: {
      conversations: conversations.length,
      active: conversations.filter((item) => !item.isArchived).length,
      archived: conversations.filter((item) => item.isArchived).length,
      unassigned: conversations.filter((item) => !item.projectName).length,
      projects: projects.length,
    },
    projects: projectContext,
    conversations,
  };
}

// 어떤 필드가 달라졌는지 이름으로 돌려준다. 드리프트 오류가 대화 ID만 알려주면
// 원격에서 무엇이 바뀐 것인지 알 수 없어 복구 판단을 할 수 없다.
// createTime 은 비교하지 않는다. 생성 시각은 불변이라 변경 신호를 담지 않고, 실측에서
// 같은 대화의 create_time 이 수집 경로에 따라 다르게 보고됐다(2026-09-12, 47초 차이).
// 대화의 동일성은 conversationId 로 이미 확정된다. 상세는 API_COMPATIBILITY.md.
export function catalogItemDifferences(before, current) {
  const fields = [];
  if (before.title !== current.title) fields.push("title");
  if (!sameTime(before.updateTime, current.updateTime)) fields.push("updateTime");
  if (before.isArchived !== current.isArchived) fields.push("isArchived");
  if ((before.projectName || null) !== (current.projectName || null)) fields.push("projectName");
  return fields;
}

// 드리프트 사유를 사람이 읽을 수 있게 만든다. 제목·프로젝트명은 사용자 데이터이므로
// 값 자체는 남기지 않고 "무엇이 바뀌었는지"와 보관 여부만 남긴다.
export function describeMetadataDrift(before, current) {
  const fields = catalogItemDifferences(before, current)
    .filter((field) => field !== "title" && field !== "updateTime");
  return fields.map((field) => {
    // 시각은 대화 내용이 아니라 메타데이터이므로 값을 남긴다. 값이 없으면 원인을 못 찾는다.
    if (field === "createTime" || field === "updateTime") {
      return `${field} ${JSON.stringify(before[field])} -> ${JSON.stringify(current[field])}`;
    }
    if (field === "isArchived") return `isArchived ${before.isArchived} -> ${current.isArchived}`;
    if (field === "projectName") {
      const from = before.projectName ? "프로젝트 있음" : "프로젝트 없음";
      const to = current.projectName ? "프로젝트 있음" : "프로젝트 없음";
      return from === to ? "projectName 변경(다른 프로젝트로 이동)" : `projectName ${from} -> ${to}`;
    }
    return field;
  }).join(", ");
}

function catalogItemEqual(left, right) {
  return left.conversationId === right.conversationId
    && left.title === right.title
    && sameTime(left.updateTime, right.updateTime)
    && left.isArchived === right.isArchived
    && (left.projectName || null) === (right.projectName || null);
}

// 후보의 유일한 사유가 "title-format"이면 형식만 어긋난 대화다. 한 번 제안한 뒤
// 보류 목록에 파킹해 매 스캔 재분류를 막는다.
export function isFormatOnlyCandidate(candidate) {
  const reasons = candidate?.reasons || [];
  return reasons.length === 1 && reasons[0] === "title-format";
}

// 전수 수집: 모든 대화가 후보다. 사유는 "overhaul" 하나로 기록한다.
export function fullCollectionSelection(state, catalog) {
  const selected = selectMaintenanceCandidates(state, catalog, { conversations: [] });
  return {
    candidates: catalog.conversations.map((item) => ({ ...item, reasons: ["overhaul"] })),
    removedConversationIds: selected.removedConversationIds,
    suppressedByHoldIds: [],
  };
}

export function selectMaintenanceCandidates(state, catalog, holdList = { conversations: [] }) {
  assert(state?.version === 1 && state.kind === "conversation-maintenance-state",
    "Unsupported maintenance state");
  assert(catalog?.version === 1 && catalog.kind === "conversation-maintenance-catalog",
    "Unsupported maintenance catalog");
  const held = holdList && Array.isArray(holdList.conversations)
    ? holdList
    : { conversations: [] };
  const previousById = new Map(state.conversations.map((item) => [item.conversationId, item]));
  const currentIds = new Set(catalog.conversations.map((item) => item.conversationId));
  const candidates = [];
  const suppressedByHoldIds = [];
  for (const current of catalog.conversations) {
    const previous = previousById.get(current.conversationId);
    const reasons = [];
    if (!previous) reasons.push("new");
    else {
      if (!sameTime(current.updateTime, previous.updateTime)) reasons.push("updated");
      if (current.title !== previous.title) reasons.push("title-changed");
      if (current.isArchived !== previous.isArchived) reasons.push("archive-changed");
      if ((current.projectName || null) !== (previous.projectName || null)) reasons.push("project-changed");
    }
    if (!isNormalizedTitle(current.title)) reasons.push("title-format");
    if (!reasons.length) continue;
    const candidate = { ...current, reasons: [...new Set(reasons)] };
    if (isFormatOnlyCandidate(candidate) && isHeld(held, current)) {
      suppressedByHoldIds.push(current.conversationId);
      continue;
    }
    candidates.push(candidate);
  }
  const removedConversationIds = state.conversations
    .map((item) => item.conversationId)
    .filter((id) => !currentIds.has(id))
    .sort();
  return { candidates, removedConversationIds, suppressedByHoldIds: suppressedByHoldIds.sort() };
}

// 스캔이 만든 후보를 반영해 보류 목록을 갱신한다. 형식만 어긋난 후보는 이번 한 번
// 제안한 뒤 보류 목록에 올리고(다음 스캔부터 억제), 카탈로그에서 사라졌거나 형식
// 외의 사유로 다시 후보가 됐거나 이미 표준 제목이 된 항목은 목록에서 뺀다.
function nextHoldList(holdList, catalog, candidates) {
  const catalogById = new Map(catalog.conversations.map((item) => [item.conversationId, item]));
  const formatOnlyIds = new Set(candidates.filter(isFormatOnlyCandidate).map((item) => item.conversationId));
  const otherCandidateIds = new Set(candidates
    .filter((item) => !isFormatOnlyCandidate(item))
    .map((item) => item.conversationId));
  const entriesById = new Map(holdList.conversations.map((entry) => [entry.conversationId, entry]));
  for (const [id] of [...entriesById]) {
    const current = catalogById.get(id);
    if (!current || otherCandidateIds.has(id) || isNormalizedTitle(current.title)) entriesById.delete(id);
  }
  for (const id of formatOnlyIds) entriesById.set(id, holdEntry(catalogById.get(id)));
  const conversations = [...entriesById.values()]
    .sort((left, right) => left.conversationId.localeCompare(right.conversationId));
  const signature = (list) => JSON.stringify(list.map((entry) =>
    [entry.conversationId, entry.title, entry.updateTime, entry.isArchived, entry.projectName]));
  const previous = [...holdList.conversations]
    .sort((left, right) => left.conversationId.localeCompare(right.conversationId));
  return { changed: signature(conversations) !== signature(previous), list: { ...holdList, conversations } };
}

function conversationRecord(catalogItem, data, raw, backupFile) {
  const id = data?.conversation_id || data?.id;
  assert(id === catalogItem.conversationId, `Conversation download returned a different ID: ${catalogItem.conversationId}`);
  assert(data?.title === catalogItem.title, `Conversation title changed during scan: ${catalogItem.conversationId}`);
  assert(data?.mapping && typeof data.mapping === "object" && Object.keys(data.mapping).length > 0,
    `Conversation has no mapping: ${catalogItem.conversationId}`);
  return {
    ...catalogItem,
    messageCount: Object.values(data.mapping).filter((node) => node?.message).length,
    attachmentReferenceCount: attachmentReferenceCount(data),
    contentSha256: contentSha256(data),
    backupFile,
    backupBytes: raw.length,
    backupSha256: sha256(raw),
  };
}

// resume 이면 이미 받은 본문이 이 대화와 맞을 때 다시 받지 않고 재사용한다.
// 맞지 않거나 깨진 파일은 새로 받아 덮어쓴다.
async function downloadConversation(api, catalogItem, jsonDirectory, { resume = false } = {}) {
  const backupFile = resolve(jsonDirectory, `${catalogItem.conversationId}.json`);
  if (resume && existsSync(backupFile)) {
    try {
      const raw = readFileSync(backupFile);
      return conversationRecord(catalogItem, JSON.parse(raw.toString("utf8")), raw, backupFile);
    } catch {}
  }
  const response = await api.getConversation(catalogItem.conversationId);
  assert(response.ok, `Conversation download failed for ${catalogItem.conversationId}: HTTP ${response.status}`
    + (response.bodySnippet ? ` (${String(response.bodySnippet).slice(0, 120)})` : ""));
  const data = response.data;
  const raw = Buffer.from(JSON.stringify(data, null, 2));
  const record = conversationRecord(catalogItem, data, raw, backupFile);
  writeFileSync(backupFile, raw, { mode: 0o600, flag: resume ? "w" : "wx" });
  return record;
}

function maintenanceInventory({ mode, runRoot, catalogPath, catalog, conversations,
  removedConversationIds, confirmedUnavailableConversationIds = [], heldConversationIds = [],
  source, warnings = [] }) {
  return {
    version: 1,
    kind: "conversation-maintenance-inventory",
    generatedAt: catalog.generatedAt,
    runRoot,
    catalogFile: catalogPath,
    source: { mode, ...source },
    counts: {
      catalogConversations: catalog.conversations.length,
      candidates: conversations.length,
      removed: removedConversationIds.length,
      confirmedUnavailable: confirmedUnavailableConversationIds.length,
      held: heldConversationIds.length,
      attachmentReferences: conversations.reduce((sum, item) => sum + item.attachmentReferenceCount, 0),
    },
    warnings,
    removedConversationIds,
    confirmedUnavailableConversationIds,
    heldConversationIds,
    projects: catalog.projects,
    conversations: conversations.sort((left, right) => left.conversationId.localeCompare(right.conversationId)),
  };
}

function maintenanceState(catalog, source = null) {
  return {
    version: 1,
    kind: "conversation-maintenance-state",
    generatedAt: catalog.generatedAt,
    ...(source ? { source } : {}),
    scope: catalog.scope,
    counts: catalog.counts,
    projects: catalog.projects,
    conversations: catalog.conversations,
  };
}

export async function seedMaintenanceRun({ previousInventoryPath, runDir, api, now = () => new Date() }) {
  const previousRaw = readFileSync(previousInventoryPath);
  const previous = JSON.parse(previousRaw.toString("utf8"));
  const supportedBaseline = previous?.version === 1
    && ["conversation-inventory", "conversation-maintenance-catalog"].includes(previous.kind)
    && Array.isArray(previous.conversations);
  assert(supportedBaseline,
    "Seed requires a full conversation inventory or a prior maintenance catalog");
  if (previous.kind === "conversation-inventory") {
    assert(Array.isArray(previous.warnings) && previous.warnings.length === 0,
      `Previous inventory is not safe: ${(previous.warnings || []).join("; ")}`);
  }
  const root = prepareRunDirectory(runDir);
  const catalog = await collectConversationCatalog(api, now);
  const catalogPath = join(root, "catalog.json");
  const previousById = new Map(previous.conversations.map((item) => [item.conversationId, item]));
  const candidates = [];
  for (const catalogItem of catalog.conversations) {
    const reasons = [];
    if (!previousById.has(catalogItem.conversationId)) reasons.push("new");
    if (!isNormalizedTitle(catalogItem.title)) reasons.push("title-format");
    if (reasons.length) {
      candidates.push({
        ...await downloadConversation(api, catalogItem, join(root, "json")),
        reasons,
      });
    }
  }
  const currentIds = new Set(catalog.conversations.map((item) => item.conversationId));
  const removedConversationIds = previous.conversations
    .map((item) => item.conversationId)
    .filter((id) => !currentIds.has(id))
    .sort();
  writeJsonNew(catalogPath, catalog);
  const inventory = maintenanceInventory({
    mode: "seed",
    runRoot: root,
    catalogPath,
    catalog,
    conversations: candidates,
    removedConversationIds,
    source: {
      ...(previous.kind === "conversation-inventory"
        ? { previousInventoryDigest: sha256(previousRaw) }
        : { previousCatalogDigest: sha256(previousRaw) }),
      previousBaselineKind: previous.kind,
      baselinePolicy: "accept-current-catalog-after-completed-cleanup",
    },
  });
  const inventoryPath = join(root, "inventory.json");
  writeJsonNew(inventoryPath, inventory);
  return { root, inventoryPath, catalog, inventory };
}

// full 이면 변경 여부와 무관하게 카탈로그의 모든 대화를 후보로 받는다(전수 재정비 수집).
// 보류 목록은 적용하지 않고, 도중에 끊긴 실행 폴더는 같은 runDir 로 이어받는다.
export async function scanMaintenanceRun({ statePath, runDir, api, dataDir, full = false, now = () => new Date(), onProgress = () => {} }) {
  const stateRaw = readFileSync(statePath);
  const state = JSON.parse(stateRaw.toString("utf8"));
  const root = prepareRunDirectory(runDir, { resume: full });
  const holdDir = dataDir ? resolve(dataDir) : dirname(resolve(statePath));
  const holdList = readHoldList(holdDir);
  const catalog = await collectConversationCatalog(api, now, onProgress);
  const catalogPath = join(root, "catalog.json");
  const selected = full
    ? fullCollectionSelection(state, catalog)
    : selectMaintenanceCandidates(state, catalog, holdList);
  const confirmedUnavailableConversationIds = [];
  const unresolvedRemovedConversationIds = [];
  for (const [index, conversationId] of selected.removedConversationIds.entries()) {
    onProgress({ phase: "removed", index, total: selected.removedConversationIds.length });
    const response = await api.getConversation(conversationId);
    if (response?.status === 404) confirmedUnavailableConversationIds.push(conversationId);
    else unresolvedRemovedConversationIds.push(conversationId);
  }
  const candidates = [];
  for (const [index, candidate] of selected.candidates.entries()) {
    onProgress({ phase: "downloads", index, total: selected.candidates.length });
    candidates.push({
      ...await downloadConversation(api, candidate, join(root, "json"), { resume: full }),
      reasons: candidate.reasons,
    });
  }
  onProgress({ phase: "downloads", index: selected.candidates.length, total: selected.candidates.length });
  writeJsonNew(catalogPath, catalog);
  const nextHold = nextHoldList(holdList, catalog, full ? [] : candidates);
  if (nextHold.changed && !full) writeHoldList(holdDir, nextHold.list, now);
  const warnings = unresolvedRemovedConversationIds.length
    ? ["Previously checkpointed conversations are missing; reconcile them before advancing the checkpoint"]
    : [];
  const inventory = maintenanceInventory({
    mode: full ? "overhaul" : "scan",
    runRoot: root,
    catalogPath,
    catalog,
    conversations: candidates,
    removedConversationIds: selected.removedConversationIds,
    confirmedUnavailableConversationIds,
    heldConversationIds: selected.suppressedByHoldIds,
    source: { stateDigest: sha256(stateRaw) },
    warnings,
  });
  const inventoryPath = join(root, "inventory.json");
  writeJsonNew(inventoryPath, inventory);
  let checkpointAdvanced = false;
  if (candidates.length === 0 && warnings.length === 0) {
    writeJsonReplace(resolve(statePath), maintenanceState(catalog, { scanInventoryDigest: sha256(readFileSync(inventoryPath)) }));
    checkpointAdvanced = true;
  }
  return { root, inventoryPath, catalog, inventory, checkpointAdvanced };
}

// 빠른 검증(quiet): 사용자가 수집 이후 다른 대화를 만들거나 고치지 않았다고 가정하고 전체 카탈로그를
// 다시 수집하는 대신 기준 카탈로그에 확인된 변경만 반영한다. 제목·삭제·이동은 적용 단계가 이미
// 대화별로 다시 읽어 검증했다. 가정이 깨진 흔적은 최근 수정 순 목록의 앞부분만 대조해 잡는다
// (새 대화·편집된 대화는 목록 맨 위로 올라온다).
async function recentDriftCheck({ api, baseline, plannedIds, margin = 20, maxPages = 8, onProgress = () => {} }) {
  const byId = new Map(baseline.conversations.map((item) => [item.conversationId, item]));
  const fresh = new Map();
  let others = 0;
  for (let page = 0; page < maxPages && others < margin; page++) {
    onProgress({ phase: "drift", index: page, total: maxPages });
    const data = unwrap(await api.listConversations({ archived: false, offset: page * PAGE_SIZE, limit: PAGE_SIZE }),
      "Recent conversation check");
    const items = data.items || [];
    if (!items.length) break;
    for (const item of items) {
      if (!CONVERSATION_ID.test(item.id || "")) continue;
      if (plannedIds.has(item.id)) {
        fresh.set(item.id, { updateTime: item.update_time ?? null, title: item.title });
        continue;
      }
      others++;
      const known = byId.get(item.id);
      assert(known, `New conversation appeared during maintenance: ${item.id} (빠른 검증 가정 위반 — 전체 검증으로 다시 실행하세요)`);
      assert(item.title === known.title && sameTime(item.update_time, known.updateTime),
        `Conversation changed during maintenance: ${item.id} (빠른 검증 가정 위반 — 전체 검증으로 다시 실행하세요)`);
      if (others >= margin) break;
    }
    if (data.has_next === false || items.length < PAGE_SIZE) break;
  }
  onProgress({ phase: "drift", index: maxPages, total: maxPages });
  return fresh;
}

function catalogFrom(base, conversations, now) {
  return {
    ...base,
    generatedAt: now().toISOString(),
    counts: {
      ...base.counts,
      conversations: conversations.length,
      active: conversations.filter((item) => !item.isArchived).length,
      archived: conversations.filter((item) => item.isArchived).length,
      unassigned: conversations.filter((item) => !item.projectName).length,
    },
    projects: projectCatalog(base.projects, conversations),
    conversations,
  };
}

async function quietCheckpointCatalog({ api, before, decisions, now, onProgress }) {
  const deleted = new Set(decisions.filter((item) => item.decision === "delete").map((item) => item.conversationId));
  const renamed = new Map(decisions.filter((item) => item.decision === "keep" && item.newTitle)
    .map((item) => [item.conversationId, item.newTitle]));
  // 이동 예정 대화도 계획된 변경이다. 이미 옮겨졌다면 수정 시각이 바뀌어 목록 앞쪽에 나타난다.
  const beforeById = new Map(before.conversations.map((item) => [item.conversationId, item]));
  const moving = decisions.filter((item) => item.decision === "keep" && item.projectName
    && item.projectName !== beforeById.get(item.conversationId)?.projectName).map((item) => item.conversationId);
  const fresh = await recentDriftCheck({ api, baseline: before,
    plannedIds: new Set([...deleted, ...renamed.keys(), ...moving]), onProgress });
  const conversations = before.conversations.filter((item) => !deleted.has(item.conversationId)).map((item) => ({
    ...item,
    ...(renamed.has(item.conversationId) ? { title: renamed.get(item.conversationId) } : {}),
    ...(fresh.has(item.conversationId) ? { updateTime: fresh.get(item.conversationId).updateTime } : {}),
  }));
  return catalogFrom(before, conversations, now);
}

function mutationDecisions(decisions) {
  return decisions.filter((item) => item.decision !== "keep" || item.newTitle);
}

function validateCompletedPlans(plansDir, inventoryDigest, decisionsDigest, expectedIds) {
  assert(plansDir, "--plans is required when reviewed decisions contain mutations");
  const planSet = loadPlanSet(plansDir);
  assert(planSet.summary.remainingActions === 0, "Management plans are not fully applied");
  assert(planSet.summary.uncertainActions.length === 0, "Management plans contain uncertain actions");
  const actionIds = [];
  for (const plan of planSet.plans) {
    assert(plan.manifest.source?.inventoryDigest === inventoryDigest,
      `Plan source inventory does not match: ${plan.path}`);
    assert(plan.manifest.source?.decisionsDigest === decisionsDigest,
      `Plan source decisions do not match: ${plan.path}`);
    actionIds.push(...plan.manifest.actions.map((item) => item.conversationId));
  }
  assert(JSON.stringify(actionIds.sort()) === JSON.stringify([...expectedIds].sort()),
    "Completed plan actions do not exactly match reviewed mutations");
}

export async function checkpointMaintenanceRun({ inventoryPath, decisionsPath, statePath, plansDir, api, quiet = false,
  now = () => new Date(), onProgress = () => {} }) {
  const inventoryRaw = readFileSync(inventoryPath);
  const decisionsRaw = readFileSync(decisionsPath);
  const inventory = JSON.parse(inventoryRaw.toString("utf8"));
  const decisionsFile = JSON.parse(decisionsRaw.toString("utf8"));
  const inventoryDigest = sha256(inventoryRaw);
  const decisionsDigest = sha256(decisionsRaw);
  assert(inventory?.version === 1 && inventory.kind === "conversation-maintenance-inventory",
    "Checkpoint requires a maintenance inventory");
  assert(Array.isArray(inventory.warnings) && inventory.warnings.length === 0,
    `Maintenance inventory is not safe: ${(inventory.warnings || []).join("; ")}`);
  assert(decisionsFile?.version === 1 && decisionsFile.kind === "reviewed-decisions",
    "Checkpoint requires reviewed decisions");
  assert(decisionsFile.inventoryDigest === inventoryDigest, "Reviewed decisions do not match the inventory");
  assert(Array.isArray(decisionsFile.decisions), "Reviewed decisions are missing");
  const candidateIds = inventory.conversations.map((item) => item.conversationId).sort();
  const reviewedIds = decisionsFile.decisions.map((item) => item.conversationId).sort();
  assert(JSON.stringify(candidateIds) === JSON.stringify(reviewedIds),
    "Every maintenance candidate must have exactly one reviewed decision");
  assert(decisionsFile.decisions.every((item) => item.reviewed === true),
    "Every maintenance candidate must be reviewed");
  const inventoryById = new Map(inventory.conversations.map((item) => [item.conversationId, item]));
  for (const decision of decisionsFile.decisions) {
    assert(["keep", "delete"].includes(decision.decision),
      `Unsupported reviewed decision: ${decision.conversationId}`);
    assert(!(decision.decision === "delete" && decision.newTitle),
      `A deleted conversation cannot also be renamed: ${decision.conversationId}`);
    if (decision.decision !== "delete") {
      assert(isNormalizedTitle(decision.newTitle || inventoryById.get(decision.conversationId)?.title),
        `Reviewed title must use the exact "topic — work/result" form: ${decision.conversationId}`);
      assertOptionalProjectName(decision.projectName,
        `Reviewed projectName for ${decision.conversationId}`);
      // A decision.projectName that differs from the conversation's current
      // project is a real move between two existing projects, handled by
      // compileProjectRouting()/runProjectRouting() after this checkpoint —
      // not something this checkpoint needs to reject.
    }
  }
  if (["scan", "overhaul"].includes(inventory.source?.mode)) {
    const stateRaw = readFileSync(statePath);
    assert(sha256(stateRaw) === inventory.source.stateDigest,
      "Maintenance state changed after this scan; run a new scan");
  }
  const mutations = mutationDecisions(decisionsFile.decisions);
  if (mutations.length) {
    validateCompletedPlans(plansDir, inventoryDigest, decisionsDigest,
      mutations.map((item) => item.conversationId));
  }

  const before = readJson(inventory.catalogFile, "Maintenance catalog");
  const current = quiet
    ? await quietCheckpointCatalog({ api, before, decisions: decisionsFile.decisions, now, onProgress })
    : await collectConversationCatalog(api, now, onProgress);
  const beforeById = new Map(before.conversations.map((item) => [item.conversationId, item]));
  const currentById = new Map(current.conversations.map((item) => [item.conversationId, item]));
  const decisionsById = new Map(decisionsFile.decisions.map((item) => [item.conversationId, item]));
  const candidateById = new Map(inventory.conversations.map((item) => [item.conversationId, item]));
  for (const currentItem of current.conversations) {
    assert(beforeById.has(currentItem.conversationId),
      `New conversation appeared during maintenance: ${currentItem.conversationId}`);
  }
  for (const beforeItem of before.conversations) {
    const decision = decisionsById.get(beforeItem.conversationId);
    const currentItem = currentById.get(beforeItem.conversationId);
    if (decision?.decision === "delete") {
      assert(!currentItem, `Deleted conversation is still visible: ${beforeItem.conversationId}`);
      continue;
    }
    assert(currentItem, `Conversation disappeared during maintenance: ${beforeItem.conversationId}`);
    const isPlannedMove = decision?.decision === "keep" && !decision.newTitle
      && decision.projectName && decision.projectName !== beforeItem.projectName;
    if (isPlannedMove) {
      // A pure project move (no title change) is compiled into a separate
      // routing plan applied after this checkpoint — so at checkpoint time
      // the conversation may still be at its old project (routing hasn't run
      // yet) or already at the new one (a previous attempt's routing partly
      // succeeded before this retry). Either is expected; anything else, or
      // a title/archived change, is not.
      assert(currentItem.title === beforeItem.title && currentItem.isArchived === beforeItem.isArchived
        && (currentItem.projectName === beforeItem.projectName || currentItem.projectName === decision.projectName),
        `Conversation changed unexpectedly during maintenance: ${beforeItem.conversationId}`
        + ` (${catalogItemDifferences(beforeItem, currentItem).join(", ")})`);
      continue;
    }
    if (!decision || (decision.decision === "keep" && !decision.newTitle)) {
      assert(catalogItemEqual(beforeItem, currentItem),
        `Conversation changed during maintenance: ${beforeItem.conversationId}`
        + ` (${catalogItemDifferences(beforeItem, currentItem).join(", ")})`);
      continue;
    }
    const expectedTitle = decision.newTitle || beforeItem.title;
    assert(currentItem.title === expectedTitle,
      `Applied title does not match the reviewed decision: ${beforeItem.conversationId}`);
    const drift = describeMetadataDrift(beforeItem, currentItem);
    assert(!drift,
      `Conversation metadata drifted during maintenance: ${beforeItem.conversationId} (${drift})`);
    if (quiet) continue;
    const downloaded = await api.getConversation(beforeItem.conversationId);
    assert(downloaded.ok, `Could not verify maintained conversation: ${beforeItem.conversationId}`);
    assert(contentSha256(downloaded.data) === candidateById.get(beforeItem.conversationId)?.contentSha256,
      `Conversation content changed during maintenance: ${beforeItem.conversationId}`);
  }
  assert(current.conversations.length === before.conversations.length
    - decisionsFile.decisions.filter((item) => item.decision === "delete").length,
  "Conversation count changed unexpectedly during maintenance");

  const state = maintenanceState(current, { inventoryDigest, decisionsDigest, ...(quiet ? { verification: "assume-quiet" } : {}) });
  writeJsonReplace(resolve(statePath), state);
  return { statePath: resolve(statePath), state, inventoryDigest, decisionsDigest };
}

export async function synchronizeMaintenanceStateAfterProjectRouting({
  statePath,
  routingPath,
  api,
  quiet = false,
  now = () => new Date(),
  onProgress = () => {},
}) {
  const stateRaw = readFileSync(statePath);
  const routingRaw = readFileSync(routingPath);
  const state = JSON.parse(stateRaw.toString("utf8"));
  const routing = validateProjectRouting(JSON.parse(routingRaw.toString("utf8")));
  assert(state?.version === 1 && state.kind === "conversation-maintenance-state"
    && Array.isArray(state.conversations), "Unsupported maintenance state");
  const routingStatus = projectRoutingStatus(routing);
  assert(routingStatus.pendingTargets === 0, "Project routing is not fully applied");

  const plannedById = new Map();
  for (const target of routing.targets) {
    for (const action of target.actions) {
      plannedById.set(action.conversationId, {
        expectedTitle: action.expectedTitle,
        projectName: target.project.name,
      });
    }
  }
  const previousById = new Map(state.conversations.map((item) => [item.conversationId, item]));
  for (const conversationId of plannedById.keys()) {
    assert(previousById.has(conversationId),
      `Routed conversation is not present in the maintenance state: ${conversationId}`);
  }

  let current;
  if (quiet) {
    // 이동은 프로젝트 배치 단계가 대화별로 다시 읽어 검증하고 영수증에 남겼다.
    const fresh = await recentDriftCheck({ api, baseline: state, plannedIds: new Set(plannedById.keys()), onProgress });
    current = catalogFrom(state, state.conversations.map((item) => ({
      ...item,
      ...(plannedById.has(item.conversationId) ? { projectName: plannedById.get(item.conversationId).projectName } : {}),
      ...(fresh.has(item.conversationId) ? { updateTime: fresh.get(item.conversationId).updateTime } : {}),
    })), now);
  } else {
    current = await collectConversationCatalog(api, now, onProgress);
  }
  const currentById = new Map(current.conversations.map((item) => [item.conversationId, item]));
  const deferredNewConversationIds = current.conversations
    .map((item) => item.conversationId)
    .filter((conversationId) => !previousById.has(conversationId))
    .sort();
  for (const previousItem of state.conversations) {
    const currentItem = currentById.get(previousItem.conversationId);
    assert(currentItem,
      `Conversation disappeared after the maintenance checkpoint: ${previousItem.conversationId}`);
    const planned = plannedById.get(previousItem.conversationId);
    if (!planned) {
      assert(catalogItemEqual(previousItem, currentItem),
        `Unplanned conversation change blocks routing synchronization: ${previousItem.conversationId}`);
      continue;
    }
    assert(previousItem.title === planned.expectedTitle && currentItem.title === planned.expectedTitle,
      `Routed conversation title does not match the plan: ${previousItem.conversationId}`);
    assert(currentItem.isArchived === previousItem.isArchived,
      `Routed conversation metadata drifted: ${previousItem.conversationId}`);
    assert(currentItem.projectName === planned.projectName,
      `Routed conversation is not in the planned project: ${previousItem.conversationId}`);
  }

  const trackedConversations = current.conversations
    .filter((item) => previousById.has(item.conversationId));
  const trackedCatalog = {
    ...current,
    counts: {
      ...current.counts,
      conversations: trackedConversations.length,
      active: trackedConversations.filter((item) => !item.isArchived).length,
      archived: trackedConversations.filter((item) => item.isArchived).length,
      unassigned: trackedConversations.filter((item) => !item.projectName).length,
    },
    projects: projectCatalog(current.projects, trackedConversations),
    conversations: trackedConversations,
  };
  const nextState = maintenanceState(trackedCatalog, {
    previousStateDigest: sha256(stateRaw),
    projectRoutingDigest: projectRoutingDigest(routing),
    routingFileDigest: sha256(routingRaw),
    deferredNewConversationIds,
    ...(quiet ? { verification: "assume-quiet" } : {}),
  });
  writeJsonReplace(resolve(statePath), nextState);
  return {
    statePath: resolve(statePath),
    state: nextState,
    routingDigest: routingStatus.routingDigest,
    synchronizedConversations: plannedById.size,
    deferredNewConversationIds,
  };
}

// 읽기 전용 접근 진단. API_COMPATIBILITY.md "계약이 깨졌을 때의 순서" 2단계용으로,
// 같은 세션에서 대화 읽기와 프로젝트 목록을 각각 시도해 인증·계정 헤더 문제와
// 특정 엔드포인트 계약 문제를 가른다. 상태 코드와 개수만 남기고 제목·ID·본문은 남기지 않는다.
export async function diagnoseReadAccess({ api }) {
  assert(api?.listConversations && api?.listProjectSidebar, "Read diagnostics need the API adapter");
  const checks = [];
  const record = async (name, call) => {
    try {
      const response = await call();
      const data = response?.data;
      const items = data?.list?.items || data?.items || null;
      const detail = data?.detail?.message || (typeof data?.detail === "string" ? data.detail : "");
      checks.push({
        name,
        status: response?.status ?? null,
        ok: response?.ok === true,
        items: Array.isArray(items) ? items.length : null,
        ...(response?.ok ? {} : {
          contentType: response?.contentType || "",
          detail: String(detail).slice(0, 200),
          bodySnippet: String(response?.bodySnippet || "").slice(0, 200),
        }),
      });
    } catch (error) {
      checks.push({ name, status: null, ok: false, error: error?.message || "request failed" });
    }
  };
  await record("conversations", () => api.listConversations({ limit: 1 }));
  await record("projects-sidebar", () => api.listProjectSidebar({ limit: 1 }));
  return { checks };
}

function usage() {
  return "원격 maintenance CLI는 폐기되었습니다. 로컬 앱을 사용하세요.";
}

function parseOptions(values, positionalCount) {
  assert(values.length >= positionalCount, usage());
  const positional = values.slice(0, positionalCount);
  let accountId = "";
  let plansDir = "";
  let dataDir = "";
  let requestDelayMs = 1000;
  for (let index = positionalCount; index < values.length; index++) {
    const option = values[index];
    const value = values[++index];
    assert(value !== undefined, `Missing value for ${option}`);
    if (option === "--account-id") accountId = value;
    else if (option === "--data-dir") dataDir = value;
    else if (option === "--plans") plansDir = value;
    else if (option === "--request-delay-seconds") {
      const seconds = Number(value);
      assert(Number.isFinite(seconds) && seconds >= 0, "--request-delay-seconds must be non-negative");
      requestDelayMs = Math.round(seconds * 1000);
    } else throw new Error(`Unknown option: ${option}\n${usage()}`);
  }
  return { positional, accountId, plansDir, dataDir, requestDelayMs };
}

async function main(args) {
  void args;
  throw new Error("원격 CLI 명령은 폐기되었습니다. 로컬 앱에서 ChatGPT 릴레이를 연결해 실행하세요.");
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
