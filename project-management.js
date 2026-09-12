import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { assert } from "./assert.js";
import { exactKeys } from "./exact-keys.js";
import { ACCOUNT_ID, CONVERSATION_ID, PROJECT_ID } from "./ids.js";

try { process.umask(0o077); } catch {}

function cleanText(value, label, { min = 0, max }) {
  assert(typeof value === "string", `${label} must be a string`);
  assert(value === value.trim(), `${label} must not have leading or trailing whitespace`);
  assert(value.length >= min && value.length <= max,
    `${label} must contain ${min}-${max} characters`);
  return value;
}

export function validateProjectPlacementPlan(input) {
  assert(input && typeof input === "object" && !Array.isArray(input), "Plan must be an object");
  exactKeys(input, ["version", "kind", "workspace", "receiptDir", "project", "actions"], "Plan");
  assert(input.version === 1, "Plan version must be 1");
  assert(input.kind === "chatgpt-project-placement-plan",
    "Plan kind must be chatgpt-project-placement-plan");
  assert(input.workspace === "business", "Plan workspace must be business");
  assert(typeof input.receiptDir === "string" && isAbsolute(input.receiptDir),
    "receiptDir must be an absolute path");

  const project = input.project;
  assert(project && typeof project === "object" && !Array.isArray(project), "project must be an object");
  const projectKeys = ["name", "instructions", "createIfMissing", "approved"];
  if (project.projectId !== undefined) projectKeys.push("projectId");
  exactKeys(project, projectKeys, "project");
  const name = cleanText(project.name, "project.name", { min: 1, max: 100 });
  const instructions = cleanText(project.instructions, "project.instructions", { min: 0, max: 8000 });
  assert(typeof project.createIfMissing === "boolean", "project.createIfMissing must be boolean");
  assert(project.approved === true, "project.approved must be true");
  if (project.projectId !== undefined) {
    assert(PROJECT_ID.test(project.projectId), "project.projectId is invalid");
    assert(project.createIfMissing === false,
      "project.createIfMissing must be false when project.projectId is supplied");
  }

  assert(Array.isArray(input.actions), "actions must be an array");
  assert(input.actions.length <= 25, "A project placement plan is limited to 25 conversations");
  assert(project.createIfMissing || input.actions.length > 0,
    "Plan must create a project or move at least one conversation");
  const seen = new Set();
  const actions = input.actions.map((action, index) => {
    const label = `actions[${index}]`;
    assert(action && typeof action === "object" && !Array.isArray(action), `${label} must be an object`);
    exactKeys(action,
      ["conversationId", "expectedTitle", "expectedSourceProjectId", "approved"], label);
    assert(CONVERSATION_ID.test(action.conversationId || ""), `${label}.conversationId is invalid`);
    assert(!seen.has(action.conversationId), `${label}.conversationId is duplicated`);
    seen.add(action.conversationId);
    const expectedTitle = cleanText(action.expectedTitle, `${label}.expectedTitle`, { min: 1, max: 256 });
    assert(action.expectedSourceProjectId === null,
      `${label}.expectedSourceProjectId must be null; this workflow only moves projectless conversations`);
    assert(action.approved === true, `${label}.approved must be true`);
    return {
      conversationId: action.conversationId,
      expectedTitle,
      expectedSourceProjectId: null,
      approved: true,
    };
  });

  return {
    version: 1,
    kind: "chatgpt-project-placement-plan",
    workspace: "business",
    receiptDir: resolve(input.receiptDir),
    project: {
      name,
      instructions,
      createIfMissing: project.createIfMissing,
      approved: true,
      ...(project.projectId ? { projectId: project.projectId } : {}),
    },
    actions,
  };
}

export function projectPlacementPlanDigest(plan) {
  const normalized = validateProjectPlacementPlan(plan);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function projectPlacementConfirmation(plan) {
  const normalized = validateProjectPlacementPlan(plan);
  const create = normalized.project.createIfMissing ? "YES" : "NO";
  return `APPLY PROJECT PLAN; CREATE IF MISSING ${create}; MOVE ${normalized.actions.length} CONVERSATIONS; PLAN ${projectPlacementPlanDigest(normalized).slice(0, 12)}`;
}

export function prepareProjectPlacement(plan) {
  const normalized = validateProjectPlacementPlan(plan);
  return {
    ok: true,
    phase: "prepare",
    planDigest: projectPlacementPlanDigest(normalized),
    expectedConfirmation: projectPlacementConfirmation(normalized),
    project: normalized.project,
    actions: normalized.actions,
  };
}

function projectFromItem(item) {
  const candidates = [
    item?.resource?.gizmo?.gizmo,
    item?.resource?.gizmo,
    item?.gizmo?.gizmo,
    item?.gizmo,
    item,
  ];
  for (const candidate of candidates) {
    const projectId = candidate?.id || "";
    if (!PROJECT_ID.test(projectId)) continue;
    return {
      projectId,
      projectName: candidate.display?.name || candidate.name || projectId,
    };
  }
  return null;
}

export async function listOwnedProjects(api) {
  assert(api?.listProjects, "Project API adapter is incomplete");
  const projects = new Map();
  const seenCursors = new Set();
  let cursor = "";
  while (true) {
    const response = await api.listProjects(cursor);
    assert(response && typeof response === "object", "Project discovery returned an invalid response");
    assert(response.ok, `Project discovery failed: HTTP ${response.status}`);
    assert(response.data && typeof response.data === "object", "Project discovery returned invalid JSON");
    const items = response.data.list?.items || response.data.items || [];
    for (const item of items) {
      const project = projectFromItem(item);
      if (project) projects.set(project.projectId, project);
    }
    const next = response.data.list?.cursor || response.data.cursor || response.data.next_cursor || "";
    if (!next) break;
    assert(!seenCursors.has(next), "Project pagination cursor repeated");
    seenCursors.add(next);
    cursor = next;
  }
  return [...projects.values()].sort((left, right) =>
    left.projectName.localeCompare(right.projectName) || left.projectId.localeCompare(right.projectId));
}

function findTargetProject(projects, target) {
  if (target.projectId) {
    const project = projects.find((item) => item.projectId === target.projectId);
    assert(project, `Target project was not found: ${target.projectId}`);
    assert(project.projectName === target.name,
      `Target project name does not match ${target.projectId}`);
    return project;
  }
  const matches = projects.filter((item) => item.projectName === target.name);
  assert(matches.length <= 1,
    `More than one owned project has the name "${target.name}"; specify project.projectId`);
  return matches[0] || null;
}

function conversationPlacement(response, action, targetProjectId = null) {
  assert(response && typeof response === "object", `Invalid response for ${action.conversationId}`);
  assert(response.ok, `Could not read ${action.conversationId}: HTTP ${response.status}`);
  const data = response.data;
  const id = data?.conversation_id || data?.id;
  assert(id === action.conversationId, `Remote conversation ID does not match ${action.conversationId}`);
  assert(data?.title === action.expectedTitle, `Remote title does not match ${action.conversationId}`);
  assert(data?.is_visible !== false, `Conversation is not visible: ${action.conversationId}`);
  const currentGizmoId = data?.gizmo_id || null;
  const currentProjectId = PROJECT_ID.test(currentGizmoId || "") ? currentGizmoId : null;
  assert(currentProjectId === null || currentProjectId === targetProjectId,
    `Conversation is already in another project: ${action.conversationId}`);
  return {
    currentGizmoId,
    currentProjectId,
    conversationTemplateId: data?.conversation_template_id || null,
    state: targetProjectId && currentProjectId === targetProjectId ? "already-target" : "projectless",
  };
}

async function inspectConversation(api, action, targetProjectId = null) {
  return conversationPlacement(await api.getConversation(action.conversationId), action, targetProjectId);
}

function writeReceiptAtPath(path, receipt) {
  const partial = `${path}.partial-${randomUUID()}`;
  try {
    writeFileSync(partial, JSON.stringify(receipt, null, 2), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(partial, path);
  } catch (error) {
    try { unlinkSync(partial); } catch {}
    throw error;
  }
}

function createReceiptFile(receiptDir, receipt) {
  mkdirSync(receiptDir, { recursive: true });
  const stamp = receipt.startedAt.replace(/[:.]/g, "-");
  const path = join(receiptDir, `${stamp}_${receipt.runId}_project-placement.json`);
  writeReceiptAtPath(path, receipt);
  return path;
}

async function discoverCreatedProject(api, target, attempts, delayMs, sleep) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const projects = await listOwnedProjects(api);
    const project = findTargetProject(projects, target);
    if (project) return project;
    if (attempt + 1 < attempts && delayMs > 0) await sleep(delayMs);
  }
  return null;
}

export async function runProjectPlacementWorkflow({
  plan: rawPlan,
  accountId,
  confirmation,
  reviewedConversationIds,
  api,
  now = () => new Date(),
  discoveryAttempts = 5,
  discoveryDelayMs = 1000,
  verificationAttempts = 3,
  verificationDelayMs = 1000,
  initialProjects = null,
  batchRemotePreflight = true,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
}) {
  assert(ACCOUNT_ID.test(accountId || ""), "A valid ChatGPT Business account ID is required");
  assert(api?.getConversation && api?.listProjects && api?.createProject && api?.moveConversation,
    "Project API adapter is incomplete");
  assert(Number.isInteger(discoveryAttempts) && discoveryAttempts >= 1,
    "discoveryAttempts must be a positive integer");
  assert(Number.isInteger(verificationAttempts) && verificationAttempts >= 1,
    "verificationAttempts must be a positive integer");

  const plan = validateProjectPlacementPlan(rawPlan);
  const planDigest = projectPlacementPlanDigest(plan);
  const expectedConfirmation = projectPlacementConfirmation(plan);
  assert(confirmation === expectedConfirmation, "Confirmation phrase does not match the plan");
  const expectedReviewedIds = plan.actions.map((action) => action.conversationId);
  assert(Array.isArray(reviewedConversationIds), "Every move must be reviewed by the user");
  assert(JSON.stringify(reviewedConversationIds) === JSON.stringify(expectedReviewedIds),
    "Reviewed conversation IDs do not exactly match the plan");

  assert(initialProjects === null || Array.isArray(initialProjects),
    "initialProjects must be null or an array");
  assert(typeof batchRemotePreflight === "boolean", "batchRemotePreflight must be boolean");
  const projects = initialProjects || await listOwnedProjects(api);
  let targetProject = findTargetProject(projects, plan.project);
  if (!targetProject) {
    assert(plan.project.createIfMissing,
      `Target project does not exist and creation is not approved: ${plan.project.name}`);
  }

  const preflight = [];
  if (batchRemotePreflight) {
    for (const action of plan.actions) {
      try {
        const remote = await inspectConversation(api, action, targetProject?.projectId || null);
        preflight.push({ ...action, remote, ok: true });
      } catch (error) {
        preflight.push({ ...action, ok: false, error: error.message });
      }
    }
  }
  if (preflight.some((item) => !item.ok)) {
    return { ok: false, phase: "preflight", planDigest, expectedConfirmation, preflight };
  }

  const receipt = {
    version: 1,
    kind: "chatgpt-project-placement-receipt",
    runId: randomUUID(),
    workspace: plan.workspace,
    startedAt: now().toISOString(),
    status: "running",
    verificationProfile: batchRemotePreflight ? "strict" : "efficient",
    planDigest,
    expectedConfirmation,
    project: plan.project,
    reviewedConversationIds: expectedReviewedIds,
    results: [],
  };
  const receiptFile = createReceiptFile(plan.receiptDir, receipt);

  try {
    if (!targetProject) {
      receipt.currentAction = { type: "create-project", projectName: plan.project.name };
      writeReceiptAtPath(receiptFile, receipt);
      let createResponse = null;
      let createError = null;
      try {
        createResponse = await api.createProject({
          name: plan.project.name,
          instructions: plan.project.instructions,
        });
      } catch (error) {
        createError = error.message;
      }
      targetProject = await discoverCreatedProject(
        api, plan.project, discoveryAttempts, discoveryDelayMs, sleep);
      const detail = createError || (createResponse ? `HTTP ${createResponse.status}` : "no response");
      assert(targetProject, `Project creation could not be verified (${detail})`);
      receipt.results.push({
        type: "create-project",
        projectId: targetProject.projectId,
        projectName: targetProject.projectName,
        requestStatus: createResponse?.status ?? null,
        verified: true,
        ok: true,
      });
      delete receipt.currentAction;
      writeReceiptAtPath(receiptFile, receipt);
    } else {
      receipt.results.push({
        type: "resolve-project",
        projectId: targetProject.projectId,
        projectName: targetProject.projectName,
        ok: true,
      });
      writeReceiptAtPath(receiptFile, receipt);
    }

    for (const action of plan.actions) {
      receipt.currentAction = {
        type: "move-conversation",
        conversationId: action.conversationId,
        targetProjectId: targetProject.projectId,
      };
      writeReceiptAtPath(receiptFile, receipt);
      const before = await inspectConversation(api, action, targetProject.projectId);
      if (before.state === "already-target") {
        receipt.results.push({
          type: "move-conversation",
          conversationId: action.conversationId,
          targetProjectId: targetProject.projectId,
          verification: "already-target",
          ok: true,
        });
        delete receipt.currentAction;
        writeReceiptAtPath(receiptFile, receipt);
        continue;
      }

      let moveResponse = null;
      let moveError = null;
      try {
        moveResponse = await api.moveConversation(action.conversationId, targetProject.projectId);
      } catch (error) {
        moveError = error.message;
      }

      let verified = false;
      let verificationError = null;
      let afterPlacement = null;
      for (let attempt = 0; attempt < verificationAttempts; attempt++) {
        try {
          const after = await inspectConversation(api, action, targetProject.projectId);
          verified = after.state === "already-target";
          afterPlacement = after;
          if (verified) break;
        } catch (error) {
          verificationError = error.message;
        }
        if (attempt + 1 < verificationAttempts && verificationDelayMs > 0) {
          await sleep(verificationDelayMs);
        }
      }
      const detail = moveError
        || verificationError
        || (moveResponse ? `HTTP ${moveResponse.status}` : "no response");
      assert(verified, `Conversation move could not be verified: ${action.conversationId} (${detail})`);
      receipt.results.push({
        type: "move-conversation",
        conversationId: action.conversationId,
        targetProjectId: targetProject.projectId,
        sourceGizmoId: before.currentGizmoId,
        sourceConversationTemplateId: before.conversationTemplateId,
        observedConversationTemplateId: afterPlacement?.conversationTemplateId ?? null,
        requestStatus: moveResponse?.status ?? null,
        verification: "target-project",
        ok: true,
      });
      delete receipt.currentAction;
      writeReceiptAtPath(receiptFile, receipt);
    }

    receipt.status = "completed";
    receipt.finishedAt = now().toISOString();
    delete receipt.currentAction;
    writeReceiptAtPath(receiptFile, receipt);
    return {
      ok: true,
      phase: "apply",
      planDigest,
      project: targetProject,
      results: receipt.results,
      receiptFile,
    };
  } catch (error) {
    receipt.status = "failed";
    receipt.error = error.message;
    receipt.finishedAt = now().toISOString();
    writeReceiptAtPath(receiptFile, receipt);
    return {
      ok: false,
      phase: "apply",
      planDigest,
      error: error.message,
      results: receipt.results,
      receiptFile,
    };
  }
}
