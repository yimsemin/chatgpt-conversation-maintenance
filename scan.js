// 스캔: 고른 범위의 대화를 후보로 삼고 후보 본문을 받아 인벤토리를 만든다. ChatGPT는 읽기만 한다.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assert } from "./assert.js";
import { runFiles } from "./run-files.js";
import { writeJsonAtomic } from "./fs-json.js";
import { attachmentReferenceCount, contentSha256, sha256 } from "./content-hash.js";
import { collectConversationCatalog, collectScopedCatalog } from "./catalog.js";

try { process.umask(0o077); } catch {}

// 수집 도중 끊긴 실행만 같은 폴더에서 이어받는다. 인벤토리까지 만든 실행은 다시 쓰지 않는다.
function prepareRunDirectory(path) {
  const root = resolve(path);
  mkdirSync(root, { recursive: true });
  assert(statSync(root).isDirectory(), `Run path is not a directory: ${root}`);
  assert(readdirSync(root).every((name) => name === "json"), `Run directory is not resumable: ${root}`);
  mkdirSync(join(root, "json"), { recursive: true });
  return root;
}

// 조사 범위. kind: "unassigned"(프로젝트 없는 대화) | "project"(projectName 프로젝트) | "recent"(최근 days일 안에 수정) |
// "all"(모든 대화, 보관된 것 포함 — 전체 재정비용).
export const SCOPE_KINDS = ["unassigned", "project", "recent", "all"];
export const MAX_RECENT_DAYS = 3650;
export const MAX_SCOPE_PROJECTS = 20;

export function validateScope(scope) {
  assert(scope && typeof scope === "object" && !Array.isArray(scope), "조사 범위가 올바르지 않습니다");
  assert(SCOPE_KINDS.includes(scope.kind), "조사 범위 종류가 올바르지 않습니다");
  if (scope.kind === "project") {
    // 프로젝트 여러 개를 고를 수 있다(projectNames). 하나만 적은 옛 형식(projectName)도 받는다.
    const names = Array.isArray(scope.projectNames) ? scope.projectNames : [scope.projectName];
    assert(names.length >= 1 && names.length <= MAX_SCOPE_PROJECTS, `프로젝트는 1~${MAX_SCOPE_PROJECTS}개를 고르세요`);
    for (const name of names) {
      assert(typeof name === "string" && name.trim() === name && name.length > 0 && name.length <= 100, "프로젝트 이름이 올바르지 않습니다");
    }
    return { kind: "project", projectNames: [...new Set(names)] };
  }
  if (scope.kind === "recent") {
    assert(Number.isInteger(scope.days) && scope.days >= 1 && scope.days <= MAX_RECENT_DAYS,
      "최근 일수는 1 이상의 정수여야 합니다");
    return { kind: "recent", days: scope.days };
  }
  return { kind: scope.kind };
}

export function describeScope(scope) {
  if (scope.kind === "project") return `프로젝트 ${scope.projectNames.map((name) => `「${name}」`).join(", ")}`;
  if (scope.kind === "recent") return `최근 ${scope.days}일 안에 수정된 대화`;
  if (scope.kind === "all") return "모든 대화";
  return "프로젝트에 넣지 않은 대화";
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

function maintenanceInventory({ runRoot, catalogPath, catalog, conversations, scope }) {
  return {
    version: 1,
    kind: "conversation-maintenance-inventory",
    generatedAt: catalog.generatedAt,
    runRoot,
    catalogFile: catalogPath,
    source: { mode: "scope", scope },
    counts: {
      catalogConversations: catalog.conversations.length,
      candidates: conversations.length,
      attachmentReferences: conversations.reduce((sum, item) => sum + item.attachmentReferenceCount, 0),
    },
    warnings: [],
    projects: catalog.projects,
    conversations: conversations.sort((left, right) => left.conversationId.localeCompare(right.conversationId)),
  };
}

// 범위 안의 대화를 모두 후보로 받는다(지난 확인과 비교하지 않는다). 도중에 끊긴 실행 폴더는 같은 runDir 로 이어받는다.
// 프로젝트·기록 파일은 만들지 않고 실행 폴더(runDir)에만 결과를 남긴다.
export async function scanMaintenanceRun({ runDir, api, scope, now = () => new Date(), onProgress = () => {} }) {
  const validScope = validateScope(scope);
  const root = prepareRunDirectory(runDir);
  const catalog = validScope.kind === "all"
    ? await collectConversationCatalog(api, now, onProgress)
    : await collectScopedCatalog(api, validScope, now, onProgress);
  const catalogPath = runFiles(root).catalog;
  const selected = catalog.conversations
    .filter((item) => validScope.kind === "all" || !item.isArchived)
    .map((item) => ({ ...item, reasons: ["scope"] }));
  const candidates = [];
  for (const [index, candidate] of selected.entries()) {
    onProgress({ phase: "downloads", index, total: selected.length });
    candidates.push({
      ...await downloadConversation(api, candidate, join(root, "json"), { resume: true }),
      reasons: candidate.reasons,
    });
  }
  onProgress({ phase: "downloads", index: selected.length, total: selected.length });
  writeJsonAtomic(catalogPath, catalog, { exclusive: true });
  const inventory = maintenanceInventory({ runRoot: root, catalogPath, catalog, conversations: candidates, scope: validScope });
  const inventoryPath = runFiles(root).inventory;
  writeJsonAtomic(inventoryPath, inventory, { exclusive: true });
  return { root, inventoryPath, catalog, inventory };
}
