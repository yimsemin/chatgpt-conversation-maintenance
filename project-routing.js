import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { assert } from "./assert.js";
import {
  listOwnedProjects,
  projectPlacementConfirmation,
  projectPlacementPlanDigest,
  runProjectPlacementWorkflow,
  validateProjectPlacementPlan,
} from "./project-management.js";

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(JSON.stringify(actual) === JSON.stringify(wanted),
    `${label} must contain only: ${wanted.join(", ")}`);
}

export function validateProjectRouting(input) {
  assert(input && typeof input === "object" && !Array.isArray(input), "Routing plan must be an object");
  exactKeys(input, ["version", "kind", "workspace", "receiptDir", "targets"], "Routing plan");
  assert(input.version === 1, "Routing plan version must be 1");
  assert(input.kind === "chatgpt-project-routing", "Routing plan kind must be chatgpt-project-routing");
  assert(input.workspace === "business", "Routing plan workspace must be business");
  assert(Array.isArray(input.targets) && input.targets.length > 0,
    "Routing plan targets must be a non-empty array");
  assert(input.targets.length <= 50, "Routing plan is limited to 50 target projects");

  const conversationIds = new Set();
  const projectKeys = new Set();
  let totalActions = 0;
  const targets = input.targets.map((target, index) => {
    const label = `targets[${index}]`;
    assert(target && typeof target === "object" && !Array.isArray(target), `${label} must be an object`);
    exactKeys(target, ["project", "actions"], label);
    const plan = validateProjectPlacementPlan({
      version: 1,
      kind: "chatgpt-project-placement-plan",
      workspace: input.workspace,
      receiptDir: input.receiptDir,
      project: target.project,
      actions: target.actions,
    });
    const projectKey = plan.project.projectId || `name:${plan.project.name}`;
    assert(!projectKeys.has(projectKey), `Routing target is duplicated: ${projectKey}`);
    projectKeys.add(projectKey);
    for (const action of plan.actions) {
      assert(!conversationIds.has(action.conversationId),
        `Conversation appears in more than one routing target: ${action.conversationId}`);
      conversationIds.add(action.conversationId);
    }
    totalActions += plan.actions.length;
    return { project: plan.project, actions: plan.actions };
  });
  assert(totalActions > 0, "Routing plan must move at least one conversation");
  assert(totalActions <= 200, "Routing plan is limited to 200 conversations");

  return {
    version: 1,
    kind: "chatgpt-project-routing",
    workspace: "business",
    receiptDir: validateProjectPlacementPlan({
      version: 1,
      kind: "chatgpt-project-placement-plan",
      workspace: input.workspace,
      receiptDir: input.receiptDir,
      project: targets[0].project,
      actions: targets[0].actions,
    }).receiptDir,
    targets,
  };
}

export function projectRoutingDigest(routing) {
  const normalized = validateProjectRouting(routing);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function projectRoutingConfirmation(routing) {
  const normalized = validateProjectRouting(routing);
  const creates = normalized.targets.filter((target) => target.project.createIfMissing).length;
  const moves = normalized.targets.reduce((sum, target) => sum + target.actions.length, 0);
  return `APPLY PROJECT ROUTING; CREATE UP TO ${creates} PROJECTS; MOVE ${moves} CONVERSATIONS; PLAN ${projectRoutingDigest(normalized).slice(0, 12)}`;
}

export function prepareProjectRouting(routing) {
  const normalized = validateProjectRouting(routing);
  return {
    ok: true,
    phase: "prepare-routing",
    routingDigest: projectRoutingDigest(normalized),
    expectedConfirmation: projectRoutingConfirmation(normalized),
    targetCount: normalized.targets.length,
    createUpTo: normalized.targets.filter((target) => target.project.createIfMissing).length,
    conversationCount: normalized.targets.reduce((sum, target) => sum + target.actions.length, 0),
    targets: normalized.targets.map((target) => ({
      project: target.project,
      conversationCount: target.actions.length,
      conversations: target.actions.map((action) => ({
        conversationId: action.conversationId,
        expectedTitle: action.expectedTitle,
      })),
    })),
  };
}

function placementPlan(routing, target) {
  return validateProjectPlacementPlan({
    version: 1,
    kind: "chatgpt-project-placement-plan",
    workspace: routing.workspace,
    receiptDir: routing.receiptDir,
    project: target.project,
    actions: target.actions,
  });
}

export function projectRoutingStatus(routing) {
  const normalized = validateProjectRouting(routing);
  const receipts = [];
  if (existsSync(normalized.receiptDir)) {
    for (const file of readdirSync(normalized.receiptDir).filter((name) => name.endsWith(".json")).sort()) {
      try {
        const receipt = JSON.parse(readFileSync(join(normalized.receiptDir, file), "utf8"));
        receipts.push({ file, receipt });
      } catch {}
    }
  }
  const targets = normalized.targets.map((target, index) => {
    const plan = placementPlan(normalized, target);
    const planDigest = projectPlacementPlanDigest(plan);
    const completedReceipt = receipts.find(({ receipt }) => {
      if (receipt?.kind !== "chatgpt-project-placement-receipt"
        || receipt.status !== "completed"
        || receipt.planDigest !== planDigest) return false;
      const successfulMoves = new Set((receipt.results || [])
        .filter((result) => result?.type === "move-conversation" && result.ok === true)
        .map((result) => result.conversationId));
      return plan.actions.every((action) => successfulMoves.has(action.conversationId));
    });
    return {
      index,
      projectName: plan.project.name,
      conversationCount: plan.actions.length,
      planDigest,
      completed: Boolean(completedReceipt),
      receiptFile: completedReceipt ? join(normalized.receiptDir, completedReceipt.file) : null,
    };
  });
  return {
    routingDigest: projectRoutingDigest(normalized),
    targets,
    totalTargets: targets.length,
    completedTargets: targets.filter((target) => target.completed).length,
    pendingTargets: targets.filter((target) => !target.completed).length,
    totalConversations: normalized.targets.reduce((sum, target) => sum + target.actions.length, 0),
    completedConversations: targets
      .filter((target) => target.completed)
      .reduce((sum, target) => sum + target.conversationCount, 0),
  };
}

export async function runProjectRouting({
  routing: rawRouting,
  confirmation,
  accountId,
  api,
  startTarget = 0,
  maxTargets = Number.POSITIVE_INFINITY,
  pendingOnly = false,
  onProgress = () => {},
}) {
  assert(api?.listProjects && api?.getConversation && api?.createProject && api?.moveConversation,
    "Project API adapter is incomplete");
  assert((Number.isInteger(maxTargets) && maxTargets > 0) || maxTargets === Number.POSITIVE_INFINITY,
    "maxTargets must be a positive integer");
  assert(Number.isInteger(startTarget) && startTarget >= 0, "startTarget must be a non-negative integer");
  assert(typeof pendingOnly === "boolean", "pendingOnly must be boolean");
  const routing = validateProjectRouting(rawRouting);
  const routingDigest = projectRoutingDigest(routing);
  const expectedConfirmation = projectRoutingConfirmation(routing);
  assert(confirmation === expectedConfirmation, "Confirmation phrase does not match the routing plan");

  const projectCatalog = await listOwnedProjects(api);
  const results = [];
  const targetEntries = routing.targets.map((target, index) => ({ target, index }));
  const initialStatus = pendingOnly ? projectRoutingStatus(routing) : null;
  const candidates = pendingOnly
    ? targetEntries.filter(({ index }) => !initialStatus.targets[index].completed)
    : targetEntries;
  const selected = candidates.slice(startTarget, startTarget + maxTargets);
  assert(selected.length > 0, "startTarget is beyond the routing target list");
  for (const [selectedIndex, entry] of selected.entries()) {
    const { target, index } = entry;
    const plan = placementPlan(routing, target);
    onProgress({
      type: "target-start",
      index: index + 1,
      targets: routing.targets.length,
      projectName: plan.project.name,
      conversations: plan.actions.length,
    });
    const result = await runProjectPlacementWorkflow({
      plan,
      accountId,
      confirmation: projectPlacementConfirmation(plan),
      reviewedConversationIds: plan.actions.map((action) => action.conversationId),
      api,
      initialProjects: projectCatalog,
      batchRemotePreflight: false,
    });
    results.push({ projectName: plan.project.name, ...result });
    onProgress({
      type: "target-finish",
      index: index + 1,
      projectName: plan.project.name,
      ok: result.ok,
      receiptFile: result.receiptFile || null,
    });
    if (!result.ok) {
      return {
        ok: false,
        phase: "apply-routing",
        routingDigest,
        completedTargets: results.filter((item) => item.ok).length,
        results,
      };
    }
    if (!projectCatalog.some((project) => project.projectId === result.project.projectId)) {
      projectCatalog.push(result.project);
    }
  }

  const finalStatus = projectRoutingStatus(routing);
  return {
    ok: true,
    phase: "apply-routing",
    routingDigest,
    appliedTargets: results.length,
    startTarget,
    pendingOnly,
    completedTargets: finalStatus.completedTargets,
    remainingTargets: finalStatus.pendingTargets,
    results,
  };
}
