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
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assert } from "./assert.js";
import { attachmentReferenceCount, contentSha256, sha256, stableJson } from "./content-hash.js";
import { managementManifestDigest, validateManagementManifest } from "./management.js";
import { projectRoutingDigest, validateProjectRouting } from "./project-routing.js";
import { isNormalizedTitle } from "./title-rules.js";

try { process.umask(0o077); } catch {}

const DECISIONS = new Set(["keep", "archive", "delete"]);
const MAINTENANCE_DECISIONS = new Set(["keep", "delete"]);
const PROPOSAL_DECISIONS = new Set(["keep", "delete", "undecided"]);
const PROPOSAL_CONFIDENCE = new Set(["high", "medium", "low"]);
// 보존 대화의 프로젝트는 선택이다(프로젝트 없음이 정상). 값이 있으면 다듬어진 이름이어야 한다.
export function assertOptionalProjectName(value, label) {
  if (value === undefined || value === null) return;
  assert(typeof value === "string" && value.trim() === value && value.length > 0,
    `${label} must be empty or a trimmed project name`);
}

const PROJECT_ACTIONS = new Set(["keep-current", "use-or-create", "manual-move", "manual-remove", "none"]);
const DIGEST = /^[0-9a-f]{64}$/;
const INVENTORY_KINDS = new Set(["conversation-inventory", "conversation-maintenance-inventory"]);

// review.json 절감: 후보 대화 본문은 앞/뒤 발췌만 담는다. 짧은 메시지는 전문,
// 긴 메시지는 head+tail+chars, 메시지가 많은 대화는 앞뒤 몇 개만 두고 나머지는 개수로.
const EXCERPT_HEAD_CHARS = 600;
const EXCERPT_TAIL_CHARS = 300;
const EXCERPT_KEEP_FULL_UNDER = EXCERPT_HEAD_CHARS + EXCERPT_TAIL_CHARS + 40;
const MESSAGE_WINDOW_HEAD = 3;
const MESSAGE_WINDOW_TAIL = 3;

// 규칙 문서를 매번 통째로 보내지 않기 위한 압축 기준. 정본은
// CLASSIFICATION_WORKFLOW.md이며 이 배열은 그 요약이다. review.json과 Claude
// 요청문에 그대로 삽입된다.
export const CLASSIFICATION_CRITERIA = [
  "목적: 필요한 과거 맥락은 살리고, 오래되거나 잘못된 맥락이 답변에 섞이는 것을 줄이며, 관리 부담을 줄인다. 판단이 갈리면 '앞으로 ChatGPT를 더 정확하고 적은 관리비용으로 쓸 수 있는가'로 정한다.",
  "역할: 각 후보에 delete·keep·undecided 중 하나, confidence(high|medium|low), 한 문장 근거를 제안한다. 승인·실행·실제 변경은 하지 않는다.",
  "delete: 재사용 가치가 없으면 삭제한다 — 테스트·실수·잡음, 중복, 실패·중단만 남은 것, 완료된 일회성, 결과가 원본(repo·문서)에 이미 반영되어 대화에 고유한 것이 없는 것, 현재 원본과 충돌해 남으면 해로운 것. 재사용 가치란 향후 같은 프로젝트 대화가 참조할 결정·근거·조사결과·산출물·선호가 있고 원본이나 후속 대화에 없는 경우다.",
  "keep: 원본에 없는 결정·근거·기각한 대안·조사결과·산출물·사용자 선호가 있다. 오래됐다는 이유만으로 삭제하지 않는다. 길이는 메시지 수가 아니라 사용자 요청과 고유 산출물로 판단한다.",
  "undecided: 대화만으로 판단하기 어려운 경우에만, 이유를 근거에 적는다. 남발하지 않는다.",
  "repo가 있는 프로젝트는 현재 repo가 진실이다. 과거 대화 내용을 현재 상태로 간주하지 않는다.",
  "제목(keep·undecided만, delete는 제목 제안 안 함): 형식은 `핵심 대상·주제 — 실제 작업 또는 결과`. 구분자는 정확히 한 번의 ` — `(양쪽 공백 1칸의 em dash), 양쪽은 비어있지 않음.",
  "현재 제목이 이 형식이고 대화 전체를 정확·구체적으로 나타내면 suggestedNewTitle을 null로 둔다. 형식이 아니면 내용이 맞아도 표준 형식의 새 제목을 제안한다.",
  "제목은 첫 질문이 아니라 대화의 최종 내용(주된 목적과 실제 결과)을 반영한다. 중복 제목은 고유 초점으로 구분한다. 날짜·버전은 시점이 핵심일 때만. 상태 태그·막연한 표현·대화에 없는 결론 금지. 대체로 15~35자.",
  "프로젝트(keep·undecided만): '같은 프로젝트에 있으면서 서로를 과거 맥락으로 참조할 때 답변 품질에 도움이 되는가'로 정한다. 맞는 프로젝트가 없으면 프로젝트 없음이 정상이다(suggestedProjectName null). 모든 대화를 억지로 프로젝트에 넣지 않는다.",
  "기존 프로젝트 배치가 잘못됐을 수 있다. 현재 프로젝트를 옳다고 가정하지 않는다. 너무 큰 프로젝트도, 작은 차이로 잘게 쪼갠 프로젝트도 피한다.",
  "프로젝트 조치: 프로젝트가 없는 대화는 새·기존 프로젝트에 배치(use-or-create) 또는 프로젝트 없음(none). 현재 프로젝트가 적합하면 keep-current. 다른 프로젝트로 옮길 것이면 manual-move. 이미 프로젝트 안에 있는데 프로젝트 없음이 맞으면 manual-remove(API로 뺄 수 없어 사용자가 수동 처리).",
  "confidence: 명시적 근거는 high, 내용상 추론은 medium, 근거가 부족하면 low(그리고 undecided).",
  "delete 항목은 suggestedNewTitle·suggestedProjectName·projectRationale를 넣지 않고 suggestedProjectAction은 none.",
];

const CLASSIFICATION_PROPOSAL_SCHEMA = {
  version: 1,
  kind: "classification-proposals",
  inventoryDigest: "후보 inventory.json의 SHA-256",
  scope: { candidateCount: 0 },
  items: [
    {
      conversationId: "대화 UUID",
      currentTitle: "현재 제목",
      projectName: null,
      reasons: ["new", "title-format"],
      suggestedDecision: "keep",
      suggestedNewTitle: "핵심 주제 — 실제 작업 또는 결과",
      suggestedProjectAction: "keep-current | use-or-create | manual-move | manual-remove | none",
      suggestedProjectName: "최종 프로젝트명 또는 null(프로젝트 없음)",
      confidence: "high",
      rationale: "간결한 보존·삭제 판단 근거",
      projectRationale: "현재 또는 새 프로젝트가 적합한 이유",
    },
  ],
};


function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`${label} is not valid JSON: ${path}`); }
}

function writeJsonAtomic(path, value) {
  assert(!existsSync(path), `Output already exists: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.partial-${randomUUID()}`;
  try {
    writeFileSync(partial, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(partial, path);
  } catch (error) {
    try { unlinkSync(partial); } catch {}
    throw error;
  }
}

function jsonFiles(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => join(path, entry.name));
}

function reviewMessageContent(message) {
  const textParts = [];
  let nonTextPartCount = 0;
  for (const part of message?.content?.parts || []) {
    if (typeof part === "string") textParts.push(part);
    else if (typeof part?.text === "string") textParts.push(part.text);
    else if (part && typeof part === "object") nonTextPartCount++;
  }
  const text = textParts.join("\n")
    .replace(/(?:cite|filecite|memcite|genui|products)(?:[\s\S]*?)?/g, "")
    .replace(/\[([^\]]+)\]\(sandbox:[^)]+\)/g, "[$1](산출물)")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const attachments = (message?.metadata?.attachments || []).map((item) => ({
    name: item?.name || item?.file_name || item?.filename || "attachment",
    ...(item?.mime_type || item?.mimeType
      ? { mimeType: item.mime_type || item.mimeType }
      : {}),
  }));
  return { text, attachments, nonTextPartCount };
}

function currentConversationPath(conversation, label) {
  const mapping = conversation.mapping || {};
  let nodeId = conversation.current_node;
  assert(typeof nodeId === "string" && mapping[nodeId], `${label} has no valid current_node`);
  const reversed = [];
  const seen = new Set();
  while (nodeId) {
    assert(mapping[nodeId], `${label} current path references a missing node`);
    assert(!seen.has(nodeId), `${label} current path contains a cycle`);
    seen.add(nodeId);
    reversed.push(mapping[nodeId]);
    nodeId = mapping[nodeId].parent || null;
  }
  return reversed.reverse();
}

export function classificationReviewConversation(source) {
  const raw = readFileSync(source.backupFile);
  assert(sha256(raw) === source.backupSha256,
    `Conversation backup digest changed: ${source.conversationId}`);
  let conversation;
  try { conversation = JSON.parse(raw.toString("utf8")); }
  catch { throw new Error(`Conversation backup is not valid JSON: ${source.backupFile}`); }
  const conversationId = conversation?.conversation_id || conversation?.id;
  assert(conversationId === source.conversationId,
    `Conversation backup ID changed: ${source.conversationId}`);
  assert(conversation?.title === source.title,
    `Conversation backup title changed: ${source.conversationId}`);

  const collected = [];
  for (const node of currentConversationPath(conversation, source.conversationId)) {
    const message = node?.message;
    if (!message || message.metadata?.is_visually_hidden_from_conversation === true) continue;
    const role = message.author?.role;
    const isUser = role === "user";
    const isFinalAssistant = role === "assistant"
      && message.end_turn === true
      && message.content?.content_type === "text";
    if (!isUser && !isFinalAssistant) continue;
    const { text, attachments, nonTextPartCount } = reviewMessageContent(message);
    if (!text && attachments.length === 0 && nonTextPartCount === 0) continue;
    collected.push({ role, text, attachments, nonTextPartCount });
  }

  let omittedMessages = 0;
  let windowed = collected;
  if (collected.length > MESSAGE_WINDOW_HEAD + MESSAGE_WINDOW_TAIL + 1) {
    omittedMessages = collected.length - MESSAGE_WINDOW_HEAD - MESSAGE_WINDOW_TAIL;
    windowed = [
      ...collected.slice(0, MESSAGE_WINDOW_HEAD),
      ...collected.slice(-MESSAGE_WINDOW_TAIL),
    ];
  }

  const messages = windowed.map(({ role, text, attachments, nonTextPartCount }) => ({
    role,
    ...excerptText(text),
    ...(attachments.length ? { attachments } : {}),
    ...(nonTextPartCount ? { nonTextPartCount } : {}),
  }));
  const reviewChars = messages.reduce((sum, message) =>
    sum + (message.chars ?? [...(message.text || "")].length), 0);

  return {
    conversationId: source.conversationId,
    title: source.title,
    projectName: source.projectName ?? null,
    reasons: source.reasons,
    createTime: source.createTime,
    updateTime: source.updateTime,
    attachmentReferenceCount: source.attachmentReferenceCount,
    sourceSha256: source.backupSha256,
    messages,
    ...(omittedMessages ? { omittedMessages } : {}),
    reviewChars,
    sourceBytes: raw.length,
    sourceMessageCount: Object.values(conversation.mapping || {}).filter((node) => node?.message).length,
  };
}

// 짧은 메시지는 전문, 긴 메시지는 앞/뒤 발췌 + 전체 글자 수.
function excerptText(text) {
  const chars = [...(text || "")];
  if (chars.length <= EXCERPT_KEEP_FULL_UNDER) return { text: text || "" };
  return {
    head: chars.slice(0, EXCERPT_HEAD_CHARS).join(""),
    tail: chars.slice(-EXCERPT_TAIL_CHARS).join(""),
    chars: chars.length,
  };
}

export function writeClassificationReview(inventoryPath, outputPath, now = () => new Date()) {
  const inventoryRaw = readFileSync(inventoryPath);
  const inventory = readJson(inventoryPath, "Inventory");
  assert(inventory?.version === 1 && inventory.kind === "conversation-maintenance-inventory",
    "Classification review requires a maintenance inventory");
  assert(Array.isArray(inventory.warnings) && inventory.warnings.length === 0,
    `Inventory is not safe to review: ${(inventory.warnings || ["missing warnings field"]).join("; ")}`);
  assert(Array.isArray(inventory.projects), "Maintenance inventory project context is missing");
  assert(Array.isArray(inventory.conversations), "Maintenance inventory conversations are missing");

  const conversations = inventory.conversations.map(classificationReviewConversation);
  const sourceBytes = conversations.reduce((sum, item) => sum + item.sourceBytes, 0);
  const reviewTextBytes = conversations.reduce((sum, item) => sum
    + item.messages.reduce((messageSum, message) =>
      messageSum + Buffer.byteLength(message.text ?? `${message.head}${message.tail}`), 0), 0);
  const reviewMessages = conversations.reduce((sum, item) => sum + item.messages.length, 0);
  const windowOmittedMessages = conversations.reduce((sum, item) => sum + (item.omittedMessages || 0), 0);
  const sourceMessages = conversations.reduce((sum, item) => sum + item.sourceMessageCount, 0);

  // 프로젝트 문맥은 관련분만: 후보가 현재 속한 프로젝트는 sampleTitles까지, 나머지는
  // 대상 선택에 필요한 이름·대화 수만 보낸다.
  const candidateProjectNames = new Set(
    conversations.map((item) => item.projectName).filter(Boolean));
  const projects = inventory.projects.map((project) =>
    candidateProjectNames.has(project.projectName)
      ? project
      : { projectName: project.projectName, conversationCount: project.conversationCount });

  const review = {
    version: 1,
    kind: "classification-review",
    generatedAt: now().toISOString(),
    inventoryDigest: sha256(inventoryRaw),
    criteria: CLASSIFICATION_CRITERIA,
    counts: {
      candidates: conversations.length,
      projects: projects.length,
      projectsWithContext: candidateProjectNames.size,
      sourceBytes,
      reviewTextBytes,
      sourceMessages,
      reviewMessages,
      excludedMessages: sourceMessages - reviewMessages,
      windowOmittedMessages,
      attachmentReferences: conversations.reduce((sum, item) => sum + item.attachmentReferenceCount, 0),
    },
    projects,
    conversations,
  };
  const output = resolve(outputPath);
  writeJsonAtomic(output, review);
  return { output, outputBytes: statSync(output).size, counts: review.counts };
}

function writeTextAtomic(path, text) {
  assert(!existsSync(path), `Output already exists: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  const partial = `${path}.partial-${randomUUID()}`;
  try {
    writeFileSync(partial, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(partial, path);
  } catch (error) {
    try { unlinkSync(partial); } catch {}
    throw error;
  }
}

// Claude 전용 요청문: 규칙·프로젝트 문맥·후보 발췌를 한 덩어리에 담아 저장소
// 문서 접근 없이도(예: claude.ai) 그대로 붙여넣어 분류할 수 있게 한다.
export function buildClaudePrompt(review, { inventoryPath = null, proposalPath = null } = {}) {
  assert(review?.version === 1 && review.kind === "classification-review",
    "Claude prompt requires a classification review");
  const digest = review.inventoryDigest;
  const count = review.counts?.candidates ?? review.conversations.length;
  const criteria = Array.isArray(review.criteria) && review.criteria.length
    ? review.criteria
    : CLASSIFICATION_CRITERIA;
  return [
    "이 요청은 ChatGPT 대화 유지관리의 '분류' 단계다. 아래 후보를 분류만 하고,",
    "승인 파일·실행 계획·실제 제목 변경·삭제·프로젝트 배치는 만들지도 실행하지도 않는다.",
    "판단에 필요한 기준은 이 메시지에 모두 있으니 저장소 문서를 따로 읽지 않아도 된다.",
    "",
    "## 판단 기준",
    ...criteria.map((line) => `- ${line}`),
    "",
    "## 프로젝트 문맥",
    "sampleTitles가 있는 항목은 후보와 관련된 프로젝트, 나머지는 이름·대화 수만 제공된다.",
    "```json",
    JSON.stringify(review.projects ?? [], null, 2),
    "```",
    "",
    `## 후보 대화 ${count}개`,
    "messages는 발췌다. head·tail·chars가 있으면 중간이 잘린 것이고, omittedMessages는 앞뒤 창 밖으로 생략된 메시지 수다.",
    "첨부·비텍스트(nonTextPartCount)나 분기 때문에 판단이 불분명하면 undecided로 둔다.",
    "```json",
    JSON.stringify(review.conversations ?? [], null, 2),
    "```",
    "",
    "## 출력",
    `아래 형식의 JSON 하나만 만든다. items는 후보 전체(정확히 ${count}개)이고 conversationId·currentTitle·projectName·reasons는 위 후보 데이터의 값을 그대로 복사한다.`,
    "```json",
    JSON.stringify(CLASSIFICATION_PROPOSAL_SCHEMA, null, 2),
    "```",
    `- inventoryDigest: "${digest}"`,
    `- scope.candidateCount: ${count}`,
    "- keep/undecided: suggestedNewTitle(null 가능), suggestedProjectAction 필수. 프로젝트를 정하면 suggestedProjectName·projectRationale 필수, 프로젝트 없음이면 suggestedProjectName null(현재 프로젝트 없음 → none, 있음 → manual-remove).",
    "- delete: suggestedNewTitle·suggestedProjectName·projectRationale 생략, suggestedProjectAction \"none\".",
    "",
    "결과 JSON 전문을 답변에 그대로 붙여 유지관리 앱의 '분류 결과 JSON 붙여넣기'에 넣을 수 있게 한다.",
    ...(inventoryPath && proposalPath
      ? [`파일 접근이 가능하면 ${proposalPath} 로 저장하고 \`node workflow.js validate-proposal "${inventoryPath}" "${proposalPath}"\` 로 검증한다.`]
      : ["파일 접근이 가능하면 proposal.json으로 저장하고 `node workflow.js validate-proposal <inventory.json> <proposal.json>` 로 검증한다."]),
  ].join("\n");
}

export function writeClaudePrompt(reviewPath, outputPath, { inventoryPath = "", proposalPath = "" } = {}) {
  const review = readJson(reviewPath, "Classification review");
  const output = resolve(outputPath);
  const text = buildClaudePrompt(review, {
    inventoryPath: inventoryPath ? resolve(inventoryPath) : null,
    proposalPath: proposalPath ? resolve(proposalPath) : null,
  });
  writeTextAtomic(output, `${text}\n`);
  return { output, outputBytes: statSync(output).size, candidateCount: review.counts?.candidates ?? review.conversations.length };
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

export function writeInventory(exportRoot, outputPath) {
  const inventory = buildInventory(exportRoot);
  writeJsonAtomic(resolve(outputPath), inventory);
  return inventory;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function titleLength(title) {
  return [...title].length;
}

export function validateClassificationProposals(inventoryPath, proposalPath) {
  const inventoryRaw = readFileSync(inventoryPath);
  const proposalRaw = readFileSync(proposalPath);
  const inventory = readJson(inventoryPath, "Inventory");
  const proposal = readJson(proposalPath, "Classification proposals");
  const inventoryDigest = sha256(inventoryRaw);

  assert(inventory?.version === 1 && inventory.kind === "conversation-maintenance-inventory",
    "Classification proposals require a maintenance inventory");
  assert(Array.isArray(inventory.warnings) && inventory.warnings.length === 0,
    `Inventory is not safe to classify: ${(inventory.warnings || ["missing warnings field"]).join("; ")}`);
  assert(Array.isArray(inventory.conversations), "Maintenance inventory conversations are missing");
  assert(Array.isArray(inventory.projects), "Maintenance inventory project context is missing");
  assert(typeof inventory.catalogFile === "string" && inventory.catalogFile,
    "Maintenance inventory catalogFile is missing");

  const catalog = readJson(inventory.catalogFile, "Maintenance catalog");
  assert(catalog?.version === 1 && catalog.kind === "conversation-maintenance-catalog",
    "Maintenance inventory catalog is invalid");
  assert(Array.isArray(catalog.projects), "Maintenance catalog project context is missing");
  assert(stableJson(inventory.projects) === stableJson(catalog.projects),
    "Maintenance inventory project context does not match its catalog");

  assert(proposal?.version === 1 && proposal.kind === "classification-proposals",
    "Unsupported classification proposals format");
  assert(proposal.inventoryDigest === inventoryDigest,
    "Classification proposals do not match the inventory digest");
  assert(proposal.scope?.candidateCount === inventory.conversations.length,
    "Classification proposal candidateCount does not match the inventory");
  assert(Array.isArray(proposal.items), "Classification proposal items are missing");
  assert(proposal.items.length === inventory.conversations.length,
    "Every maintenance candidate must have exactly one proposal");

  const inventoryById = new Map(inventory.conversations.map((item) => [item.conversationId, item]));
  const candidateIds = new Set(inventoryById.keys());
  const finalTitles = new Map();
  const deletedIds = new Set();
  const seen = new Set();
  const warnings = [];
  const decisionCounts = { keep: 0, delete: 0, undecided: 0 };

  for (const [index, item] of proposal.items.entries()) {
    const label = `items[${index}]`;
    assert(item && typeof item === "object" && !Array.isArray(item), `${label} must be an object`);
    assert(nonEmptyString(item.conversationId), `${label}.conversationId is invalid`);
    assert(!seen.has(item.conversationId), `${label}.conversationId is duplicated`);
    seen.add(item.conversationId);
    const source = inventoryById.get(item.conversationId);
    assert(source, `${label}.conversationId is not present in the inventory`);
    assert(item.currentTitle === source.title, `${label}.currentTitle does not match the inventory`);
    assert((item.projectName ?? null) === (source.projectName ?? null),
      `${label}.projectName does not match the inventory`);
    assert(stableJson(item.reasons) === stableJson(source.reasons),
      `${label}.reasons do not match the inventory`);
    assert(PROPOSAL_DECISIONS.has(item.suggestedDecision),
      `${label}.suggestedDecision must be keep, delete, or undecided`);
    assert(PROPOSAL_CONFIDENCE.has(item.confidence),
      `${label}.confidence must be high, medium, or low`);
    assert(nonEmptyString(item.rationale), `${label}.rationale is required`);
    assert(PROJECT_ACTIONS.has(item.suggestedProjectAction),
      `${label}.suggestedProjectAction is invalid`);
    if (item.suggestedDecision === "undecided") {
      assert(item.confidence === "low", `${label} undecided proposals must use low confidence`);
    } else {
      assert(item.confidence !== "low", `${label} low-confidence proposals must remain undecided`);
    }
    decisionCounts[item.suggestedDecision]++;

    if (item.suggestedDecision === "delete") {
      assert(item.suggestedNewTitle === undefined || item.suggestedNewTitle === null,
        `${label} cannot rename a conversation proposed for deletion`);
      assert(item.suggestedProjectAction === "none",
        `${label} deletion proposals must use project action none`);
      assert(item.suggestedProjectName === undefined || item.suggestedProjectName === null,
        `${label} deletion proposals cannot suggest a project`);
      assert(item.projectRationale === undefined || item.projectRationale === null,
        `${label} deletion proposals cannot include project rationale`);
      deletedIds.add(item.conversationId);
      continue;
    }

    const suggestedTitle = item.suggestedNewTitle;
    assert(suggestedTitle === undefined || suggestedTitle === null || nonEmptyString(suggestedTitle),
      `${label}.suggestedNewTitle is invalid`);
    const finalTitle = suggestedTitle || source.title;
    assert(isNormalizedTitle(finalTitle),
      `${label} must preserve or suggest the exact "topic — work/result" title form`);
    if (suggestedTitle === source.title) {
      warnings.push(`${item.conversationId}: suggestedNewTitle repeats the current title; use null`);
    }
    const length = titleLength(finalTitle);
    if (length < 15 || length > 35) {
      warnings.push(`${item.conversationId}: final title length ${length} is outside the recommended 15-35 characters`);
    }
    finalTitles.set(item.conversationId, finalTitle);

    if (item.suggestedProjectName === undefined || item.suggestedProjectName === null) {
      // 프로젝트 없음. 이미 프로젝트 안에 있으면 API로 뺄 수 없어 사용자가 수동으로 뺀다.
      assert(item.suggestedProjectAction === (source.projectName ? "manual-remove" : "none"),
        `${label}.suggestedProjectAction must be ${source.projectName ? "manual-remove" : "none"} when no project is suggested`);
      continue;
    }
    assert(nonEmptyString(item.suggestedProjectName), `${label}.suggestedProjectName is invalid`);
    assert(nonEmptyString(item.projectRationale), `${label}.projectRationale is required`);
    assert(item.suggestedProjectAction !== "manual-remove" && item.suggestedProjectAction !== "none",
      `${label}.suggestedProjectAction is invalid for a suggested project`);
    if (source.projectName) {
      const expectedAction = item.suggestedProjectName === source.projectName
        ? "keep-current"
        : "manual-move";
      assert(item.suggestedProjectAction === expectedAction,
        `${label}.suggestedProjectAction must be ${expectedAction}`);
    } else {
      assert(item.suggestedProjectAction === "use-or-create",
        `${label}.suggestedProjectAction must be use-or-create for a projectless conversation`);
    }
  }
  assert(seen.size === inventoryById.size, "Every maintenance candidate must have exactly one proposal");

  const conversationsByTitle = new Map();
  for (const conversation of catalog.conversations || []) {
    if (deletedIds.has(conversation.conversationId)) continue;
    const title = finalTitles.get(conversation.conversationId) || conversation.title;
    const ids = conversationsByTitle.get(title) || [];
    ids.push(conversation.conversationId);
    conversationsByTitle.set(title, ids);
  }
  for (const [title, ids] of conversationsByTitle) {
    if (ids.length > 1 && ids.some((id) => candidateIds.has(id))) {
      warnings.push(`Duplicate final title "${title}" for conversations: ${ids.sort().join(", ")}`);
    }
  }

  return {
    ok: true,
    inventoryDigest,
    proposalDigest: sha256(proposalRaw),
    candidateCount: inventory.conversations.length,
    decisionCounts,
    warnings,
  };
}

export function compileReviewedDecisions(inventoryPath, decisionsPath, outputDir) {
  const inventoryRaw = readFileSync(inventoryPath);
  const decisionsRaw = readFileSync(decisionsPath);
  const inventory = readJson(inventoryPath, "Inventory");
  const decisions = readJson(decisionsPath, "Reviewed decisions");
  const inventoryDigest = sha256(inventoryRaw);
  const decisionsDigest = sha256(decisionsRaw);

  assert(inventory?.version === 1 && INVENTORY_KINDS.has(inventory.kind), "Unsupported inventory format");
  assert(Array.isArray(inventory.warnings) && inventory.warnings.length === 0,
    `Inventory is not safe to compile: ${(inventory.warnings || ["missing warnings field"]).join("; ")}`);
  assert(decisions?.version === 1 && decisions.kind === "reviewed-decisions", "Unsupported reviewed decisions format");
  assert(decisions.inventoryDigest === inventoryDigest, "Reviewed decisions do not match the inventory digest");
  assert(isAbsolute(decisions.receiptDir || ""), "Reviewed decisions require an absolute receiptDir");
  assert(Array.isArray(decisions.decisions), "Reviewed decisions are missing");

  const inventoryById = new Map(inventory.conversations.map((item) => [item.conversationId, item]));
  const seen = new Set();
  const actions = [];
  for (const [index, decision] of decisions.decisions.entries()) {
    const label = `decisions[${index}]`;
    assert(decision && typeof decision === "object", `${label} must be an object`);
    assert(decision.reviewed === true, `${label} was not reviewed by the user`);
    assert(!seen.has(decision.conversationId), `${label}.conversationId is duplicated`);
    seen.add(decision.conversationId);
    const allowedDecisions = inventory.kind === "conversation-maintenance-inventory"
      ? MAINTENANCE_DECISIONS
      : DECISIONS;
    const allowedLabel = inventory.kind === "conversation-maintenance-inventory"
      ? "keep or delete"
      : "keep, archive, or delete";
    assert(allowedDecisions.has(decision.decision), `${label}.decision must be ${allowedLabel}`);
    const source = inventoryById.get(decision.conversationId);
    assert(source, `${label}.conversationId is not present in the inventory`);
    const newTitle = decision.newTitle;
    if (newTitle !== undefined) assert(typeof newTitle === "string" && newTitle.trim(), `${label}.newTitle is invalid`);
    assert(!(decision.decision === "delete" && newTitle), `${label} cannot rename a conversation that will be deleted`);
    if (inventory.kind === "conversation-maintenance-inventory" && decision.decision !== "delete") {
      assert(isNormalizedTitle(newTitle || source.title),
        `${label} must preserve or set the exact "topic — work/result" title form`);
      assertOptionalProjectName(decision.projectName, `${label}.projectName`);
      // A move between two already-existing projects is handled by
      // compileProjectRouting()/runProjectRouting(), not here — this
      // compiler only builds title/delete batches, so it no longer needs to
      // reject a decision.projectName that differs from source.projectName.
    }
    if (decision.decision === "keep" && !newTitle) continue;
    actions.push({
      conversationId: source.conversationId,
      expectedTitle: source.title,
      decision: decision.decision,
      approved: true,
      backupFile: source.backupFile,
      backupSha256: source.backupSha256,
      ...(newTitle ? { newTitle } : {}),
    });
  }
  const outDir = resolve(outputDir);
  mkdirSync(outDir, { recursive: true });
  assert(readdirSync(outDir).length === 0, `Output directory is not empty: ${outDir}`);

  const manifests = [];
  for (let offset = 0; offset < actions.length; offset += 25) {
    const manifest = validateManagementManifest({
      version: 1,
      workspace: "business",
      receiptDir: resolve(decisions.receiptDir),
      source: { inventoryDigest, decisionsDigest },
      actions: actions.slice(offset, offset + 25),
    });
    const number = String(manifests.length + 1).padStart(3, "0");
    const path = join(outDir, `batch-${number}.json`);
    writeJsonAtomic(path, manifest);
    manifests.push({ path, actions: manifest.actions.length, digest: managementManifestDigest(manifest) });
  }
  return { inventoryDigest, decisionsDigest, skippedKeep: decisions.decisions.length - actions.length, manifests };
}

export function compileProjectRouting(inventoryPath, decisionsPath, outputPath) {
  const inventoryRaw = readFileSync(inventoryPath);
  const decisionsRaw = readFileSync(decisionsPath);
  const inventory = readJson(inventoryPath, "Inventory");
  const decisions = readJson(decisionsPath, "Reviewed decisions");
  const inventoryDigest = sha256(inventoryRaw);
  assert(inventory?.version === 1 && inventory.kind === "conversation-maintenance-inventory",
    "Project routing requires a maintenance inventory");
  assert(Array.isArray(inventory.warnings) && inventory.warnings.length === 0,
    `Inventory is not safe to compile: ${(inventory.warnings || ["missing warnings field"]).join("; ")}`);
  assert(decisions?.version === 1 && decisions.kind === "reviewed-decisions",
    "Unsupported reviewed decisions format");
  assert(decisions.inventoryDigest === inventoryDigest,
    "Reviewed decisions do not match the inventory digest");
  assert(isAbsolute(decisions.receiptDir || ""), "Reviewed decisions require an absolute receiptDir");
  assert(Array.isArray(decisions.decisions), "Reviewed decisions are missing");

  const inventoryById = new Map(inventory.conversations.map((item) => [item.conversationId, item]));
  const seen = new Set();
  const targetsByName = new Map();
  for (const [index, decision] of decisions.decisions.entries()) {
    const label = `decisions[${index}]`;
    assert(decision && typeof decision === "object", `${label} must be an object`);
    assert(decision.reviewed === true, `${label} was not reviewed by the user`);
    assert(!seen.has(decision.conversationId), `${label}.conversationId is duplicated`);
    seen.add(decision.conversationId);
    const source = inventoryById.get(decision.conversationId);
    assert(source, `${label}.conversationId is not present in the inventory`);
    assert(MAINTENANCE_DECISIONS.has(decision.decision), `${label}.decision must be keep or delete`);
    if (decision.decision === "delete") {
      assert(decision.projectName === undefined || decision.projectName === null,
        `${label}.projectName must be empty for a deleted conversation`);
      continue;
    }
    assertOptionalProjectName(decision.projectName, `${label}.projectName`);
    // 프로젝트 없음이면 옮길 곳이 없다. 이미 프로젝트 안이면 사용자가 수동으로 뺀다.
    if (decision.projectName === undefined || decision.projectName === null) continue;
    if (source.projectName && decision.projectName === source.projectName) {
      continue;
    }
    const entry = targetsByName.get(decision.projectName) || { actions: [], sourceProjectNames: {} };
    entry.actions.push({
      conversationId: source.conversationId,
      expectedTitle: decision.newTitle || source.title,
      expectedSourceProjectId: null,
      approved: true,
    });
    if (source.projectName) {
      entry.sourceProjectNames[source.conversationId] = source.projectName;
    }
    targetsByName.set(decision.projectName, entry);
  }
  assert(seen.size === inventory.conversations.length,
    "Every maintenance candidate must have exactly one reviewed routing decision");

  if (targetsByName.size === 0) {
    return { inventoryDigest, decisionsDigest: sha256(decisionsRaw), routingRequired: false };
  }
  const routing = validateProjectRouting({
    version: 1,
    kind: "chatgpt-project-routing",
    workspace: "business",
    receiptDir: resolve(decisions.receiptDir),
    // 배치 계획 하나는 25건까지다. 큰 프로젝트는 같은 프로젝트를 가리키는 타깃 여러 개로 나눈다.
    targets: [...targetsByName.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([name, entry]) => {
        const chunks = [];
        for (let offset = 0; offset < entry.actions.length; offset += 25) {
          const actions = entry.actions.slice(offset, offset + 25);
          const ids = new Set(actions.map((action) => action.conversationId));
          chunks.push({
            project: { name, instructions: "", createIfMissing: true, approved: true },
            actions,
            sourceProjectNames: Object.fromEntries(
              Object.entries(entry.sourceProjectNames).filter(([id]) => ids.has(id))),
          });
        }
        return chunks;
      }),
  });
  writeJsonAtomic(resolve(outputPath), routing);
  return {
    inventoryDigest,
    decisionsDigest: sha256(decisionsRaw),
    routingRequired: true,
    routingPath: resolve(outputPath),
    routingDigest: projectRoutingDigest(routing),
    targetCount: routing.targets.length,
    conversationCount: routing.targets.reduce((sum, target) => sum + target.actions.length, 0),
  };
}

export function writeRemainingManifest(manifestPath, receiptPath, outputPath) {
  const manifest = validateManagementManifest(readJson(manifestPath, "Manifest"));
  const receipt = readJson(receiptPath, "Receipt");
  const digest = managementManifestDigest(manifest);
  assert(receipt.manifestDigest === digest, "Receipt does not match the manifest digest");
  const completed = new Set((receipt.results || []).filter((item) => item.ok === true).map((item) => item.conversationId));
  const remaining = manifest.actions.filter((action) => !completed.has(action.conversationId));
  assert(remaining.length > 0, "No remaining actions");
  const next = validateManagementManifest({ ...manifest, actions: remaining });
  writeJsonAtomic(resolve(outputPath), next);
  return next;
}

function usage() {
  return [
    "Usage:",
    "  node workflow.js inventory <export-dir> <inventory.json>",
    "  node workflow.js review <inventory.json> <review.json>",
    "  node workflow.js claude-prompt <review.json> <prompt.md> [<inventory.json> <proposal.json>]",
    "  node workflow.js validate-proposal <inventory.json> <proposal.json>",
    "  node workflow.js compile <inventory.json> <reviewed-decisions.json> <output-dir>",
    "  node workflow.js compile-routing <inventory.json> <reviewed-decisions.json> <routing.json>",
    "  node workflow.js remaining <manifest.json> <receipt.json> <remaining.json>",
  ].join("\n");
}

async function main(args) {
  const [command, ...values] = args;
  if (command === "inventory" && values.length === 2) {
    const output = resolve(values[1]);
    const inventory = writeInventory(values[0], values[1]);
    console.log(JSON.stringify({
      output,
      inventoryDigest: sha256(readFileSync(output)),
      counts: inventory.counts,
      warnings: inventory.warnings,
    }, null, 2));
    return;
  }
  if (command === "review" && values.length === 2) {
    console.log(JSON.stringify(writeClassificationReview(...values), null, 2));
    return;
  }
  if (command === "claude-prompt" && (values.length === 2 || values.length === 4)) {
    const [reviewPath, outputPath, inventoryPath = "", proposalPath = ""] = values;
    console.log(JSON.stringify(
      writeClaudePrompt(reviewPath, outputPath, { inventoryPath, proposalPath }), null, 2));
    return;
  }
  if (command === "validate-proposal" && values.length === 2) {
    console.log(JSON.stringify(validateClassificationProposals(...values), null, 2));
    return;
  }
  if (command === "compile" && values.length === 3) {
    console.log(JSON.stringify(compileReviewedDecisions(...values), null, 2));
    return;
  }
  if (command === "compile-routing" && values.length === 3) {
    console.log(JSON.stringify(compileProjectRouting(...values), null, 2));
    return;
  }
  if (command === "remaining" && values.length === 3) {
    const manifest = writeRemainingManifest(...values);
    console.log(JSON.stringify({ output: resolve(values[2]), actions: manifest.actions.length }, null, 2));
    return;
  }
  throw new Error(usage());
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
