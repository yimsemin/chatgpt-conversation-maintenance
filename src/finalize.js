// 적용 뒤 결과 확정: 승인된 결정과 완료된 계획이 서로 맞는지 확인하고, 이번 실행의 결과 카탈로그를 만든다.
// 제목·삭제·이동은 적용 단계가 대화마다 다시 읽어 검증하고 영수증에 남겼으므로 여기서는 원격을 다시 읽지 않는다.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assert } from "./assert.js";
import { readJson, writeJsonAtomic } from "./fs-json.js";
import { loadReviewedRun, reviewedPairs } from "./decision-compile.js";
import { loadPlanSet } from "./plan-set.js";
import { projectRoutingStatus, validateProjectRouting } from "./project-routing.js";
import { runFiles } from "./run-files.js";
import { timeMilliseconds } from "./catalog.js";

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

// 스캔 카탈로그에 승인된 결정을 반영한 결과 카탈로그. 삭제는 항목을 빼고, 제목 변경·이동은 값을 바꾼다.
// 프로젝트 대화 수는 읽어 둔 프로젝트(conversationCount 가 숫자)만 다시 센다. 읽지 않은 프로젝트의 수는 null 로 둔다.
export function buildAfterCatalog(before, decisions, now = () => new Date()) {
  const byId = new Map(decisions.map((item) => [item.conversationId, item]));
  const conversations = [];
  for (const item of before.conversations) {
    const decision = byId.get(item.conversationId);
    if (decision?.decision === "delete") continue;
    conversations.push(decision ? {
      ...item,
      ...(decision.newTitle ? { title: decision.newTitle } : {}),
      ...(decision.projectName ? { projectName: decision.projectName } : {}),
    } : item);
  }
  const counted = (name) => conversations.filter((item) => item.projectName === name).length;
  const projects = before.projects.map((project) => ({
    ...project, conversationCount: project.conversationCount == null ? null : counted(project.projectName),
  }));
  const known = new Set(projects.map((project) => project.projectName));
  for (const name of new Set(conversations.map((item) => item.projectName).filter(Boolean))) {
    if (!known.has(name)) projects.push({ projectName: name, conversationCount: before.scope?.complete === false ? null : counted(name), sampleTitles: [] });
  }
  projects.sort((left, right) => left.projectName.localeCompare(right.projectName));
  return {
    ...before,
    generatedAt: now().toISOString(),
    counts: {
      ...before.counts,
      conversations: conversations.length,
      active: conversations.filter((item) => !item.isArchived).length,
      archived: conversations.filter((item) => item.isArchived).length,
      unassigned: conversations.filter((item) => !item.projectName).length,
      projects: projects.length,
    },
    projects,
    conversations,
  };
}

// 제목을 바꾼 대화들의 목록 순서 확인: 원래 수정 시각이 오래된 대화가 바뀐 뒤에도 더 오래된 쪽이어야 한다.
// (계획을 오래된 순으로 만들고 한 번에 하나씩 적용하므로 지켜져야 한다. 영수증에 남은 시각으로 확인한다.)
export function checkRenameOrder(inventory, receiptDir) {
  const originalById = new Map(inventory.conversations.map((item) => [item.conversationId, timeMilliseconds(item.updateTime)]));
  const renamed = [];
  if (receiptDir && existsSync(receiptDir)) {
    for (const name of readdirSync(receiptDir).filter((item) => item.endsWith(".json"))) {
      const receipt = JSON.parse(readFileSync(join(receiptDir, name), "utf8"));
      for (const result of receipt.results || []) {
        const rename = (result.mutations || []).find((mutation) => mutation?.type === "rename");
        const after = timeMilliseconds(rename?.updateTime);
        const before = originalById.get(result.conversationId);
        if (rename && result.ok && after !== null && before !== null && before !== undefined) {
          renamed.push({ conversationId: result.conversationId, before, after });
        }
      }
    }
  }
  renamed.sort((left, right) => left.before - right.before || left.conversationId.localeCompare(right.conversationId));
  const outOfOrder = [];
  for (let index = 1; index < renamed.length; index++) {
    if (renamed[index].after < renamed[index - 1].after) outOfOrder.push(renamed[index].conversationId);
  }
  return { renamed: renamed.length, preserved: outOfOrder.length === 0, outOfOrder };
}

export function finalizeMaintenanceRun({ inventoryPath, decisionsPath, plansDir = "", routingPath = "", now = () => new Date() }) {
  const { inventory, decisionsFile, inventoryDigest, decisionsDigest } = loadReviewedRun(inventoryPath, decisionsPath);
  reviewedPairs(inventory, decisionsFile); // 후보마다 정확히 하나의 검토된 결정이 있는지 확인한다
  const mutations = mutationDecisions(decisionsFile.decisions);
  if (mutations.length) {
    validateCompletedPlans(plansDir, inventoryDigest, decisionsDigest,
      mutations.map((item) => item.conversationId));
  }
  if (routingPath) {
    assert(projectRoutingStatus(validateProjectRouting(readJson(routingPath, "프로젝트 배치 계획"))).pendingTargets === 0,
      "Project routing is not fully applied");
  }
  const before = readJson(inventory.catalogFile, "Maintenance catalog");
  const afterCatalog = buildAfterCatalog(before, decisionsFile.decisions, now);
  const afterCatalogPath = runFiles(inventory.runRoot).afterCatalog;
  writeJsonAtomic(afterCatalogPath, afterCatalog);
  const renameOrder = checkRenameOrder(inventory, decisionsFile.receiptDir);
  return { inventoryDigest, decisionsDigest, afterCatalogPath, afterCatalog, renameOrder };
}
