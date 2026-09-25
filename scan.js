// 스캔: 기준선과 현재 카탈로그를 비교해 후보를 고르고, 후보 본문을 받아 인벤토리를 만든다.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assert } from "./assert.js";
import { runFiles } from "./run-files.js";
import { writeJsonAtomic } from "./fs-json.js";
import { attachmentReferenceCount, contentSha256, sha256 } from "./content-hash.js";
import { collectConversationCatalog, sameTime } from "./catalog.js";
import { isNormalizedTitle } from "./title-rules.js";
import { holdEntry, isHeld, readHoldList, writeHoldList } from "./hold-list.js";
import { maintenanceState } from "./baseline.js";

try { process.umask(0o077); } catch {}

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

// 후보의 유일한 사유가 "title-format"이면 형식만 어긋난 대화다. 한 번 제안한 뒤
// 보류 목록에 파킹해 매 스캔 재분류를 막는다.
function isFormatOnlyCandidate(candidate) {
  const reasons = candidate?.reasons || [];
  return reasons.length === 1 && reasons[0] === "title-format";
}

// 전수 수집: 모든 대화가 후보다. 사유는 "overhaul" 하나로 기록한다.
function fullCollectionSelection(state, catalog) {
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

// full 이면 변경 여부와 무관하게 카탈로그의 모든 대화를 후보로 받는다(전수 재정비 수집).
// 보류 목록은 적용하지 않고, 도중에 끊긴 실행 폴더는 같은 runDir 로 이어받는다.
export async function scanMaintenanceRun({ statePath, runDir, api, dataDir, full = false,
  now = () => new Date(), onProgress = () => {} }) {
  const stateRaw = readFileSync(statePath);
  const state = JSON.parse(stateRaw.toString("utf8"));
  const root = prepareRunDirectory(runDir, { resume: true });
  const holdDir = dataDir ? resolve(dataDir) : dirname(resolve(statePath));
  const holdList = readHoldList(holdDir);
  const catalog = await collectConversationCatalog(api, now, onProgress);
  const catalogPath = runFiles(root).catalog;
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
      ...await downloadConversation(api, candidate, join(root, "json"), { resume: true }),
      reasons: candidate.reasons,
    });
  }
  onProgress({ phase: "downloads", index: selected.candidates.length, total: selected.candidates.length });
  writeJsonAtomic(catalogPath, catalog, { exclusive: true });
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
  const inventoryPath = runFiles(root).inventory;
  writeJsonAtomic(inventoryPath, inventory, { exclusive: true });
  let checkpointAdvanced = false;
  if (candidates.length === 0 && warnings.length === 0) {
    writeJsonAtomic(resolve(statePath), maintenanceState(catalog, { scanInventoryDigest: sha256(readFileSync(inventoryPath)) }));
    checkpointAdvanced = true;
  }
  return { root, inventoryPath, catalog, inventory, checkpointAdvanced };
}
