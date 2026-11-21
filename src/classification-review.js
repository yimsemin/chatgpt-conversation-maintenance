// 분류용 최소 입력(review.json) 생성과 요청문 작성. 대화 본문에서 현재 경로의 발췌만 뽑는다.
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { assert } from "./assert.js";
import { readJson, writeJsonAtomic, writeTextAtomic } from "./fs-json.js";
import { attachmentReferenceCount, sha256 } from "./content-hash.js";
import { translator, fallbackLocale } from "./i18n.js";
import { classificationCriteria, CLASSIFICATION_PROPOSAL_SCHEMA } from "./classification-criteria.js";

// review.json 절감: 후보 대화 본문은 앞/뒤 발췌만 담는다. 짧은 메시지는 전문,
// 긴 메시지는 head+tail+chars, 메시지가 많은 대화는 앞뒤 몇 개만 두고 나머지는 개수로.
const EXCERPT_HEAD_CHARS = 600;

const EXCERPT_TAIL_CHARS = 300;

const EXCERPT_KEEP_FULL_UNDER = EXCERPT_HEAD_CHARS + EXCERPT_TAIL_CHARS + 40;

const MESSAGE_WINDOW_HEAD = 3;

const MESSAGE_WINDOW_TAIL = 3;

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

export function writeClassificationReview(inventoryPath, outputPath, now = () => new Date(), locale = fallbackLocale) {
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
    locale,
    criteria: classificationCriteria(locale),
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
  writeJsonAtomic(output, review, { exclusive: true });
  return { output, outputBytes: statSync(output).size, counts: review.counts };
}

// Claude 전용 요청문: 규칙·프로젝트 문맥·후보 발췌를 한 덩어리에 담아 저장소
// 문서 접근 없이도(예: claude.ai) 그대로 붙여넣어 분류할 수 있게 한다.
export function buildClaudePrompt(review, { inventoryPath = null, proposalPath = null, locale = review?.locale || fallbackLocale } = {}) {
  assert(review?.version === 1 && review.kind === "classification-review",
    "Claude prompt requires a classification review");
  const t = translator(locale);
  const count = review.counts?.candidates ?? review.conversations.length;
  const template = CLASSIFICATION_PROPOSAL_SCHEMA;
  const example = {
    ...template,
    inventoryDigest: review.inventoryDigest,
    scope: { candidateCount: count },
    items: [{
      ...template.items[0],
      conversationId: t("prompt.schemaId"), currentTitle: t("prompt.schemaTitle"),
      suggestedNewTitle: t("prompt.schemaNewTitle"), suggestedProjectName: t("prompt.schemaTarget"),
      rationale: t("prompt.schemaRationale"), projectRationale: t("prompt.schemaProjectRationale"),
    }],
  };
  const criteria = classificationCriteria(locale);
  return [
    t("prompt.standaloneIntro"), "",
    `## ${t("prompt.criteria")}`, ...criteria.map((line) => `- ${line}`), "",
    `## ${t("prompt.projectContext")}`, t("prompt.samples"),
    "```json", JSON.stringify(review.projects ?? [], null, 2), "```", "",
    `## ${t("prompt.candidates", { count })}`, t("prompt.excerpts"),
    "```json", JSON.stringify(review.conversations ?? [], null, 2), "```", "",
    `## ${t("prompt.output")}`, t("prompt.outputFormat", { count }),
    "```json", JSON.stringify(example, null, 2), "```", "",
    t("prompt.validateFile", { inventory: inventoryPath || "inventory.json", proposal: proposalPath || "proposal.json" }),
    t("prompt.paste"),
  ].join("\n");
}

export function writeClaudePrompt(reviewPath, outputPath, { inventoryPath = "", proposalPath = "" } = {}) {
  const review = readJson(reviewPath, "Classification review");
  const output = resolve(outputPath);
  const text = buildClaudePrompt(review, {
    inventoryPath: inventoryPath ? resolve(inventoryPath) : null,
    proposalPath: proposalPath ? resolve(proposalPath) : null,
  });
  writeTextAtomic(output, `${text}\n`, { exclusive: true });
  return { output, outputBytes: statSync(output).size, candidateCount: review.counts?.candidates ?? review.conversations.length };
}
