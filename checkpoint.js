// 적용 뒤 검증: 제목·삭제 체크포인트와 프로젝트 배치 뒤 기준선 동기화. 전체 재수집 또는 빠른 검증(최근 수정 목록 대조).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assert } from "./assert.js";
import { readJson, writeJsonAtomic } from "./fs-json.js";
import { assertOptionalProjectName } from "./decision-compile.js";
import { contentSha256, sha256 } from "./content-hash.js";
import { CONVERSATION_ID } from "./ids.js";
import { PAGE_SIZE, catalogFrom, collectConversationCatalog, projectCatalog, sameTime, unwrap } from "./catalog.js";
import { isNormalizedTitle } from "./title-rules.js";
import { loadPlanSet } from "./plan-set.js";
import { projectRoutingDigest, projectRoutingStatus, validateProjectRouting } from "./project-routing.js";
import { catalogItemDifferences, catalogItemEqual, describeMetadataDrift } from "./catalog-diff.js";
import { maintenanceState } from "./baseline.js";

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
      assert(decision.parked === true || isNormalizedTitle(decision.newTitle || inventoryById.get(decision.conversationId)?.title),
        `Reviewed title must use the exact "topic — work/result" form: ${decision.conversationId}`);
      assertOptionalProjectName(decision.projectName,
        `Reviewed projectName for ${decision.conversationId}`);
      // A decision.projectName that differs from the conversation's current
      // project is a real move between two existing projects, handled by
      // compileProjectRouting()/runProjectRouting() after this checkpoint —
      // not something this checkpoint needs to reject.
    }
  }
  if (["scan", "overhaul", "followup"].includes(inventory.source?.mode)) {
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
  writeJsonAtomic(resolve(statePath), state);
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
  writeJsonAtomic(resolve(statePath), nextState);
  return {
    statePath: resolve(statePath),
    state: nextState,
    routingDigest: routingStatus.routingDigest,
    synchronizedConversations: plannedById.size,
    deferredNewConversationIds,
  };
}
