// AI 제안(proposal.json)이 인벤토리 해시·후보 전체성·제목 형식·프로젝트 조치 규칙을 지키는지 검증한다.
import { readFileSync } from "node:fs";
import { assert } from "./assert.js";
import { readJson } from "./fs-json.js";
import { sha256, stableJson } from "./content-hash.js";
import { isNormalizedTitle } from "./title-rules.js";

const PROPOSAL_DECISIONS = new Set(["keep", "delete", "undecided"]);

const PROPOSAL_CONFIDENCE = new Set(["high", "medium", "low"]);

const PROJECT_ACTIONS = new Set(["keep-current", "use-or-create", "manual-move", "manual-remove", "none"]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function titleLength(title) {
  return [...title].length;
}

// 제목의 주제(` — ` 앞)가 소속 프로젝트의 이름·핵심어를 그대로 되풀이하는지(동어반복). 프로젝트 이름의 앞 연월(YYMM)·gh_ 접두어는 뺀다.
function repeatsProjectName(title, projectName) {
  if (!projectName) return false;
  const squash = (text) => text.replace(/[\s_·]+/g, " ").trim();
  const core = squash(projectName.replace(/^\d{4}\s*/, "").replace(/^gh_/, ""));
  const topic = squash(String(title).split(" — ")[0]);
  if ([...core].length < 4 || [...topic].length < 4) return false;
  return topic.includes(core) || core.startsWith(topic);
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
      // 삭제후보도 표준 제목을 갖는 것이 원칙이다(삭제후보 프로젝트로 옮긴 뒤 살릴 수도 있다).
      // 현재 제목이 표준이 아니면 표준 제목을 반드시 제안해야 하고, 표준이면 null 이거나 더 나은 표준 제목이어야 한다.
      const deletionTitle = item.suggestedNewTitle;
      assert(deletionTitle === undefined || deletionTitle === null || (nonEmptyString(deletionTitle) && isNormalizedTitle(deletionTitle)),
        `${label} deletion proposals may only suggest a title in the exact "topic — work/result" form`);
      assert(isNormalizedTitle(source.title) || nonEmptyString(deletionTitle),
        `${label} must suggest a standard "topic — work/result" title even for a deletion candidate whose current title is not standard`);
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
    const finalProject = item.suggestedProjectName || source.projectName || null;
    if (repeatsProjectName(finalTitle, finalProject)) {
      warnings.push(`${item.conversationId}: title repeats its project name "${finalProject}"; describe what distinguishes the conversation inside the project`);
    }

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
