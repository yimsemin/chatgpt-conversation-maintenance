import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  prepareProjectRouting,
  projectRoutingConfirmation,
  runProjectRouting,
  validateProjectRouting,
} from "../src/project-routing.js";

const ACCOUNT_ID = "11111111-2222-4333-8444-555555555555";
const IDS = [
  "6a66ddf8-ecac-83ee-9311-0d3d3e379345",
  "6a66ddf8-ecac-83ee-9311-0d3d3e379346",
];

function routingFixture(receiptDir) {
  return {
    version: 1,
    kind: "chatgpt-project-routing",
    workspace: "business",
    receiptDir,
    targets: [
      {
        project: {
          name: "Existing",
          instructions: "",
          projectId: `g-p-${"1".repeat(32)}`,
          createIfMissing: false,
          approved: true,
        },
        actions: [{
          conversationId: IDS[0],
          expectedTitle: "First",
          expectedSourceProjectId: null,
          approved: true,
        }],
      },
      {
        project: {
          name: "New",
          instructions: "",
          createIfMissing: true,
          approved: true,
        },
        actions: [{
          conversationId: IDS[1],
          expectedTitle: "Second",
          expectedSourceProjectId: null,
          approved: true,
        }],
      },
    ],
  };
}

test("routing plans bind every target and conversation to one confirmation", () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-routing-test-"));
  try {
    const routing = routingFixture(root);
    const prepared = prepareProjectRouting(routing);
    assert.equal(prepared.targetCount, 2);
    assert.equal(prepared.createUpTo, 1);
    assert.equal(prepared.conversationCount, 2);
    assert.match(prepared.expectedConfirmation,
      /^APPLY PROJECT ROUTING; CREATE UP TO 1 PROJECTS; MOVE 2 CONVERSATIONS; PLAN [0-9a-f]{12}$/);

    routing.targets[1].actions[0].conversationId = IDS[0];
    assert.throws(() => validateProjectRouting(routing), /more than one routing target/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("routing reuses one project catalog and applies existing and new targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-routing-apply-test-"));
  const projects = [{ projectId: `g-p-${"1".repeat(32)}`, projectName: "Existing" }];
  const conversations = new Map([
    [IDS[0], { title: "First", gizmoId: null }],
    [IDS[1], { title: "Second", gizmoId: null }],
  ]);
  let listCalls = 0;
  const api = {
    listProjectSidebar: async () => {
      listCalls++;
      return {
        ok: true,
        status: 200,
        data: { items: projects.map((project) => ({
          id: project.projectId,
          display: { name: project.projectName },
        })) },
      };
    },
    getConversation: async (id) => {
      const conversation = conversations.get(id);
      return {
        ok: true,
        status: 200,
        data: {
          conversation_id: id,
          title: conversation.title,
          gizmo_id: conversation.gizmoId,
          conversation_template_id: conversation.gizmoId,
        },
      };
    },
    createProject: async ({ name }) => {
      projects.push({ projectId: `g-p-${"2".repeat(32)}`, projectName: name });
      return { ok: true, status: 200, data: {} };
    },
    moveConversation: async (id, projectId) => {
      conversations.get(id).gizmoId = projectId;
      return { ok: true, status: 200, data: { success: true } };
    },
  };
  try {
    const routing = routingFixture(root);
    const result = await runProjectRouting({
      routing,
      confirmation: projectRoutingConfirmation(routing),
      accountId: ACCOUNT_ID,
      api,
    });
    assert.equal(result.ok, true);
    assert.equal(result.completedTargets, 2);
    assert.equal(conversations.get(IDS[0]).gizmoId, `g-p-${"1".repeat(32)}`);
    assert.equal(conversations.get(IDS[1]).gizmoId, `g-p-${"2".repeat(32)}`);
    assert.equal(listCalls, 2);
    assert.equal(result.results.every((item) => item.ok), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("routing resolves a named source project and moves a conversation already in it", async () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-routing-move-test-"));
  const oldProjectId = `g-p-${"3".repeat(32)}`;
  const newProjectId = `g-p-${"4".repeat(32)}`;
  const projects = [
    { projectId: oldProjectId, projectName: "Old bucket" },
    { projectId: newProjectId, projectName: "New home" },
  ];
  let currentGizmoId = oldProjectId;
  let moveCalls = 0;
  const api = {
    listProjectSidebar: async () => ({
      ok: true,
      status: 200,
      data: { items: projects.map((project) => ({ id: project.projectId, display: { name: project.projectName } })) },
    }),
    getConversation: async () => ({
      ok: true,
      status: 200,
      data: { conversation_id: IDS[0], title: "Misfiled", gizmo_id: currentGizmoId },
    }),
    createProject: async () => { throw new Error("should not create a project"); },
    moveConversation: async (id, projectId) => {
      moveCalls++;
      currentGizmoId = projectId;
      return { ok: true, status: 200, data: {} };
    },
  };
  const routing = validateProjectRouting({
    version: 1,
    kind: "chatgpt-project-routing",
    workspace: "business",
    receiptDir: root,
    targets: [{
      project: { name: "New home", instructions: "", projectId: newProjectId, createIfMissing: false, approved: true },
      actions: [{ conversationId: IDS[0], expectedTitle: "Misfiled", expectedSourceProjectId: null, approved: true }],
      sourceProjectNames: { [IDS[0]]: "Old bucket" },
    }],
  });
  try {
    const result = await runProjectRouting({
      routing,
      confirmation: projectRoutingConfirmation(routing),
      accountId: ACCOUNT_ID,
      api,
    });
    assert.equal(result.ok, true);
    assert.equal(moveCalls, 1);
    assert.equal(currentGizmoId, newProjectId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
