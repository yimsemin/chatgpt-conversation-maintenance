import assert from "node:assert/strict";
import test from "node:test";
import { withTemp } from "./support/tmp.js";
import { fakeProjectId } from "./support/fake-chatgpt.js";

import {
  prepareProjectRouting,
  projectRoutingConfirmation,
  runProjectRouting,
  validateProjectRouting,
} from "../src/project-routing.js";

const ACCOUNT_ID = "11111111-2222-4333-8444-555555555555";
const IDS = [
  "55555555-5555-4555-8555-555555555501",
  "55555555-5555-4555-8555-555555555502",
  "55555555-5555-4555-8555-555555555503",
];
const EXISTING = fakeProjectId(1);
const NEW = fakeProjectId(2);
const SOURCE = fakeProjectId(3);

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
          projectId: EXISTING,
          createIfMissing: false,
          approved: true,
        },
        actions: [
          { conversationId: IDS[0], expectedTitle: "First", expectedSourceProjectId: null, approved: true },
          { conversationId: IDS[2], expectedTitle: "Third", expectedSourceProjectId: null, approved: true },
        ],
        sourceProjectNames: { [IDS[0]]: "Old bucket" },
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

test("routing plans bind every target and conversation to one confirmation", async () => {
  await withTemp("chatgpt-routing-test-", async (root) => {
    const routing = routingFixture(root);
    const prepared = prepareProjectRouting(routing);
    assert.equal(prepared.targetCount, 2);
    assert.equal(prepared.createUpTo, 1);
    assert.equal(prepared.conversationCount, 3);
    assert.match(prepared.expectedConfirmation,
      /^APPLY PROJECT ROUTING; CREATE UP TO 1 PROJECTS; MOVE 3 CONVERSATIONS; PLAN [0-9a-f]{12}$/);

    routing.targets[1].actions[0].conversationId = IDS[0];
    assert.throws(() => validateProjectRouting(routing), /more than one routing target/);
  });
});

test("routing resolves a named source and reuses the catalog when moving to existing and new targets", async () => {
  await withTemp("chatgpt-routing-apply-test-", async (root) => {
    const projects = [{ id: EXISTING, display: { name: "Existing" } }, { id: SOURCE, display: { name: "Old bucket" } }];
    const conversations = new Map([
      [IDS[0], { conversation_id: IDS[0], title: "First", gizmo_id: SOURCE }],
      [IDS[1], { conversation_id: IDS[1], title: "Second", gizmo_id: null }],
      [IDS[2], { conversation_id: IDS[2], title: "Third", gizmo_id: null }],
    ]);
    const moves = [];
    const created = [];
    let listCalls = 0;
    const api = {
      listProjectSidebar: async () => {
        listCalls++;
        return { ok: true, status: 200, data: { items: projects } };
      },
      getConversation: async (id) => ({ ok: true, status: 200, data: { ...conversations.get(id) } }),
      createProject: async ({ name }) => {
        created.push(name);
        projects.push({ id: NEW, display: { name } });
        return { ok: true, status: 200, data: {} };
      },
      moveConversation: async (id, projectId) => {
        moves.push([id, projectId]);
        conversations.get(id).gizmo_id = projectId;
        return { ok: true, status: 200, data: { success: true } };
      },
    };
    const routing = routingFixture(root);
    const result = await runProjectRouting({
      routing,
      confirmation: projectRoutingConfirmation(routing),
      accountId: ACCOUNT_ID,
      api,
    });
    assert.equal(result.ok, true);
    assert.equal(result.completedTargets, 2);
    assert.deepEqual(created, ["New"]);
    assert.deepEqual(moves.sort(([left], [right]) => left.localeCompare(right)), [
      [IDS[0], EXISTING], [IDS[1], NEW], [IDS[2], EXISTING],
    ]);
    assert.deepEqual(IDS.map((id) => conversations.get(id).gizmo_id), [EXISTING, NEW, EXISTING]);
    assert.equal(listCalls, 2);
    assert.deepEqual(result.results.map(({ projectName, ok }) => [projectName, ok]), [["Existing", true], ["New", true]]);
  });
});
