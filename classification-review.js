// 분류용 최소 입력(review.json) 생성과 요청문 작성. 대화 본문에서 현재 경로의 발췌만 뽑는다.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assert } from "./assert.js";
import { readJson, writeJsonAtomic } from "./fs-json.js";
import { attachmentReferenceCount, sha256 } from "./content-hash.js";
import { CLASSIFICATION_CRITERIA, CLASSIFICATION_PROPOSAL_SCHEMA } from "./classification-criteria.js";

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
  writeJsonAtomic(output, review, { exclusive: true });
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
