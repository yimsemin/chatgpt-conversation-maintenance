import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  listOwnedProjects,
  projectPlacementConfirmation,
  runProjectPlacementWorkflow,
  validateProjectPlacementPlan,
} from "../project-management.js";

// 계획을 검증해 승인 확인 문구를 만든다(적용 시험용).
function prepare(plan) {
  const normalized = validateProjectPlacementPlan(plan);
  return { project: normalized.project, actions: normalized.actions, expectedConfirmation: projectPlacementConfirmation(normalized) };
}

const ACCOUNT_ID = "11111111-2222-4333-8444-555555555555";
const CONVERSATION_ID = "6a66ddf8-ecac-83ee-9311-0d3d3e379345";
const PROJECT_CONVERSATION_ID = "6a66ddf8-ecac-83ee-9311-0d3d3e379346";
const PROJECT_ID = `g-p-${"1".repeat(32)}`;

function fixturePlan(receiptDir, overrides = {}) {
  return {
    version: 1,
    kind: "chatgpt-project-placement-plan",
    workspace: "business",
    receiptDir,
    project: {
      name: "Research",
      instructions: "",
      createIfMissing: true,
      approved: true,
      ...(overrides.project || {}),
    },
    actions: overrides.actions || [{
      conversationId: CONVERSATION_ID,
      expectedTitle: "Exact title",
      expectedSourceProjectId: null,
      approved: true,
    }],
  };
}

test("project placement plans bind explicit project creation and projectless moves", () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-project-plan-test-"));
  try {
    const prepared = prepare(fixturePlan(root));
    assert.equal(prepared.project.createIfMissing, true);
    assert.equal(prepared.actions.length, 1);
    assert.match(prepared.expectedConfirmation,
      /^APPLY PROJECT PLAN; CREATE IF MISSING YES; MOVE 1 CONVERSATIONS; PLAN [0-9a-f]{12}$/);

    const invalid = fixturePlan(root);
    invalid.actions[0].expectedSourceProjectId = "g-p-somewhere-else";
    assert.throws(() => validateProjectPlacementPlan(invalid), /must be null or a valid project ID/);

    const sourceProjectId = `g-p-${"2".repeat(32)}`;
    const withSource = fixturePlan(root);
    withSource.actions[0].expectedSourceProjectId = sourceProjectId;
    const preparedWithSource = prepare(withSource);
    assert.equal(preparedWithSource.actions[0].expectedSourceProjectId, sourceProjectId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owned-project discovery accepts sidebar wrappers and cursors", async () => {
  const cursors = [];
  const api = {
    listProjectSidebar: async ({ cursor } = {}) => {
      cursors.push(cursor);
      if (!cursor) {
        return {
          ok: true,
          status: 200,
          data: {
            items: [{ resource: { gizmo: { gizmo: { id: PROJECT_ID, display: { name: "Research" } } } } }],
            cursor: "next",
          },
        };
      }
      return {
        ok: true,
        status: 200,
        data: { list: { items: [{ id: `g-p-${"2".repeat(32)}`, display: { name: "Writing" } }] } },
      };
    },
  };
  assert.deepEqual(await listOwnedProjects(api), [
    { projectId: PROJECT_ID, projectName: "Research" },
    { projectId: `g-p-${"2".repeat(32)}`, projectName: "Writing" },
  ]);
  assert.deepEqual(cursors, ["", "next"]);
});

test("apply reconciles mutation-then-HTTP-500 responses by reading remote state", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-project-apply-test-"));
  let project = null;
  let currentGizmoId = "g-custom-image-gpt";
  let createCalls = 0;
  let moveCalls = 0;
  const api = {
    listProjectSidebar: async () => ({
      ok: true,
      status: 200,
      data: { items: project ? [{ id: project.projectId, display: { name: project.projectName } }] : [] },
    }),
    getConversation: async () => ({
      ok: true,
      status: 200,
      data: {
        conversation_id: CONVERSATION_ID,
        title: "Exact title",
        is_visible: true,
        gizmo_id: currentGizmoId,
        conversation_template_id: currentGizmoId === PROJECT_ID ? PROJECT_ID : "g-custom-image-gpt",
      },
    }),
    createProject: async () => {
      createCalls++;
      project = { projectId: PROJECT_ID, projectName: "Research" };
      return { ok: false, status: 500, data: null };
    },
    moveConversation: async () => {
      moveCalls++;
      currentGizmoId = PROJECT_ID;
      return { ok: false, status: 500, data: null };
    },
  };
  try {
    const plan = fixturePlan(root);
    const prepared = prepare(plan);
    const result = await runProjectPlacementWorkflow({
      plan,
      accountId: ACCOUNT_ID,
      confirmation: prepared.expectedConfirmation,
      reviewedConversationIds: [CONVERSATION_ID],
      api,
      sleep: async () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.project.projectId, PROJECT_ID);
    assert.equal(createCalls, 1);
    assert.equal(moveCalls, 1);
    const receipt = JSON.parse(readFileSync(result.receiptFile, "utf8"));
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.results[0].requestStatus, 500);
    assert.equal(receipt.results[1].requestStatus, 500);
    assert.equal(receipt.results[1].sourceGizmoId, "g-custom-image-gpt");
    assert.equal(receipt.results[1].sourceConversationTemplateId, "g-custom-image-gpt");
    assert.equal(receipt.results[1].observedConversationTemplateId, PROJECT_ID);
    assert.doesNotMatch(JSON.stringify(receipt), /token/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a conversation already assigned to an unexpected project is not moved", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-project-preflight-test-"));
  let writes = 0;
  const api = {
    listProjectSidebar: async () => ({
      ok: true,
      status: 200,
      data: { items: [{ id: PROJECT_ID, display: { name: "Research" } }] },
    }),
    getConversation: async () => ({
      ok: true,
      status: 200,
      data: {
        conversation_id: CONVERSATION_ID,
        title: "Exact title",
        gizmo_id: `g-p-${"f".repeat(32)}`,
      },
    }),
    createProject: async () => { writes++; },
    moveConversation: async () => { writes++; },
  };
  try {
    const plan = fixturePlan(root);
    const prepared = prepare(plan);
    const result = await runProjectPlacementWorkflow({
      plan,
      accountId: ACCOUNT_ID,
      confirmation: prepared.expectedConfirmation,
      reviewedConversationIds: [CONVERSATION_ID],
      api,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /not in the expected source project/);
    assert.equal(writes, 0);
    assert.equal(JSON.parse(readFileSync(result.receiptFile, "utf8")).status, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply moves a conversation from a named source project to a different target project", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-project-move-test-"));
  const SOURCE_PROJECT_ID = `g-p-${"3".repeat(32)}`;
  let currentGizmoId = SOURCE_PROJECT_ID;
  let moveCalls = 0;
  const api = {
    listProjectSidebar: async () => ({
      ok: true,
      status: 200,
      data: {
        items: [
          { id: SOURCE_PROJECT_ID, display: { name: "Old bucket" } },
          { id: PROJECT_ID, display: { name: "Research" } },
        ],
      },
    }),
    getConversation: async () => ({
      ok: true,
      status: 200,
      data: {
        conversation_id: CONVERSATION_ID,
        title: "Exact title",
        is_visible: true,
        gizmo_id: currentGizmoId,
      },
    }),
    createProject: async () => { throw new Error("should not create a project"); },
    moveConversation: async () => {
      moveCalls++;
      currentGizmoId = PROJECT_ID;
      return { ok: true, status: 200, data: {} };
    },
  };
  try {
    const plan = fixturePlan(root);
    plan.project.createIfMissing = false;
    plan.actions[0].expectedSourceProjectId = SOURCE_PROJECT_ID;
    const prepared = prepare(plan);
    const result = await runProjectPlacementWorkflow({
      plan,
      accountId: ACCOUNT_ID,
      confirmation: prepared.expectedConfirmation,
      reviewedConversationIds: [CONVERSATION_ID],
      api,
    });
    assert.equal(result.ok, true);
    assert.equal(moveCalls, 1);
    const moveResult = result.results.find((item) => item.type === "move-conversation");
    assert.equal(moveResult.sourceGizmoId, SOURCE_PROJECT_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
