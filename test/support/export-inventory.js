// 시험용: 내보내기 폴더(json/, projects/<이름>/json/)에서 인벤토리를 만든다. 초기 방식의 잔재라 앱은 쓰지 않고,
// 분류 검증·컴파일 시험이 실제 대화 JSON 모양의 입력을 쉽게 얻도록 남겨 둔다.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { assert } from "../../src/assert.js";
import { attachmentReferenceCount, contentSha256, sha256 } from "../../src/content-hash.js";

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`${label} could not be read: ${path}`); }
}

function jsonFiles(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => join(path, entry.name));
}

function inventoryConversation(path, projectName, projectMetadataFile) {
  const raw = readFileSync(path);
  let data;
  try { data = JSON.parse(raw.toString("utf8")); }
  catch { throw new Error(`Conversation backup is not valid JSON: ${path}`); }
  const conversationId = data?.conversation_id || data?.id;
  assert(typeof conversationId === "string" && conversationId, `Conversation backup has no ID: ${path}`);
  assert(typeof data?.title === "string" && data.title, `Conversation backup has no title: ${path}`);
  assert(data.mapping && typeof data.mapping === "object" && Object.keys(data.mapping).length > 0,
    `Conversation backup has no mapping: ${path}`);
  return {
    conversationId,
    title: data.title,
    createTime: data.create_time ?? null,
    updateTime: data.update_time ?? null,
    isArchived: data.is_archived === true,
    projectName,
    projectMetadataFile,
    messageCount: Object.values(data.mapping).filter((node) => node?.message).length,
    attachmentReferenceCount: attachmentReferenceCount(data),
    contentSha256: contentSha256(data),
    backupFile: resolve(path),
    backupBytes: statSync(path).size,
    backupSha256: sha256(raw),
  };
}

export function buildInventory(exportRoot, now = () => new Date()) {
  const root = resolve(exportRoot);
  assert(existsSync(root) && statSync(root).isDirectory(), `Export directory not found: ${root}`);

  const warnings = [];
  const projects = [];
  const conversationFiles = jsonFiles(join(root, "json")).map((path) => ({
    path,
    projectName: null,
    projectMetadataFile: null,
  }));

  const projectsRoot = join(root, "projects");
  if (existsSync(projectsRoot)) {
    for (const entry of readdirSync(projectsRoot, { withFileTypes: true }).filter((item) => item.isDirectory())) {
      const projectName = entry.name;
      const metadataPath = join(projectsRoot, projectName, "project-info.md");
      const projectMetadataFile = existsSync(metadataPath) ? resolve(metadataPath) : null;
      if (!projectMetadataFile) warnings.push(`Project metadata is missing: ${projectName}`);
      projects.push({ projectName, projectMetadataFile });
      for (const path of jsonFiles(join(projectsRoot, projectName, "json"))) {
        conversationFiles.push({ path, projectName, projectMetadataFile });
      }
    }
  }

  const allConversations = conversationFiles.map((item) =>
    inventoryConversation(item.path, item.projectName, item.projectMetadataFile));

  const summaryPath = join(root, "export-summary.json");
  const exportSummary = existsSync(summaryPath) ? readJson(summaryPath, "Export summary") : null;
  let conversations = allConversations;
  let excludedConversationBackups = [];
  let summaryBindsConversationIds = false;
  if (!exportSummary) warnings.push("export-summary.json is missing; export completeness cannot be confirmed automatically");
  if (exportSummary && exportSummary.complete !== true) warnings.push("Export summary is not complete");
  if (exportSummary?.failed > 0) warnings.push(`Export reported ${exportSummary.failed} failed conversation(s)`);
  if (exportSummary && exportSummary.scope?.conversations !== true) warnings.push("Export did not confirm that conversations were requested");
  if (exportSummary && exportSummary.scope?.projectMetadata !== true) warnings.push("Export did not confirm that project metadata was requested");
  if (exportSummary && exportSummary.scope?.attachments !== false) warnings.push("Export did not confirm that attachment downloads were disabled");
  if (exportSummary && !exportSummary.scope?.formats?.json) warnings.push("Export did not confirm that JSON output was requested");
  if (exportSummary?.dateFrom || exportSummary?.dateTo) warnings.push("Export used a date filter and is not a full snapshot");
  if (Array.isArray(exportSummary?.conversationIds)) {
    const ids = exportSummary.conversationIds;
    const expected = new Set(ids);
    if (ids.length !== expected.size || ids.some((id) => typeof id !== "string" || !id)) {
      warnings.push("Export summary conversationIds are invalid or duplicated");
    } else if (Number.isFinite(exportSummary.total) && ids.length !== exportSummary.total) {
      warnings.push("Export summary conversationIds do not match its total");
    } else {
      const selected = allConversations.filter((item) => expected.has(item.conversationId));
      const selectedIds = new Set(selected.map((item) => item.conversationId));
      if (selected.length !== selectedIds.size) {
        warnings.push("Current snapshot contains duplicate conversation backups");
      } else if (selectedIds.size !== expected.size) {
        warnings.push(`Current snapshot is missing ${expected.size - selectedIds.size} conversation backup(s)`);
      } else {
        conversations = selected;
        excludedConversationBackups = allConversations
          .filter((item) => !expected.has(item.conversationId))
          .map((item) => ({ conversationId: item.conversationId, backupFile: item.backupFile }));
        summaryBindsConversationIds = true;
      }
    }
  }
  if (exportSummary?.skipped > 0 && !summaryBindsConversationIds) {
    warnings.push("Export reused existing conversation backups without a bound conversation ID list");
  }
  if (Number.isFinite(exportSummary?.discoveredTotal) && Number.isFinite(exportSummary?.total)
    && !exportSummary.dateFrom && !exportSummary.dateTo && exportSummary.discoveredTotal !== exportSummary.total) {
    warnings.push(`Export discovered ${exportSummary.discoveredTotal} conversation(s), but selected ${exportSummary.total}`);
  }
  if (Number.isFinite(exportSummary?.total) && exportSummary.total !== conversations.length) {
    warnings.push(`Export summary selected ${exportSummary.total} conversation(s), but inventory found ${conversations.length}`);
  }

  conversations.sort((a, b) => a.conversationId.localeCompare(b.conversationId));
  const seen = new Set();
  for (const conversation of conversations) {
    assert(!seen.has(conversation.conversationId), `Duplicate conversation backup: ${conversation.conversationId}`);
    seen.add(conversation.conversationId);
  }

  return {
    version: 1,
    kind: "conversation-inventory",
    generatedAt: now().toISOString(),
    exportRoot: root,
    exportSummary,
    counts: {
      conversations: conversations.length,
      general: conversations.filter((item) => !item.projectName).length,
      project: conversations.filter((item) => item.projectName).length,
      archived: conversations.filter((item) => item.isArchived).length,
      projects: projects.length,
      attachmentReferences: conversations.reduce((sum, item) => sum + item.attachmentReferenceCount, 0),
    },
    warnings,
    excludedConversationBackups,
    projects: projects.sort((a, b) => a.projectName.localeCompare(b.projectName)),
    conversations,
  };
}
