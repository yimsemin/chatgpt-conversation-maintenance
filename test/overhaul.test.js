import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assembleProposal, sliceInventory, validateCards } from "../overhaul.js";
import { buildInventory } from "./support/export-inventory.js";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

function conversationFile(path, id, title) {
  writeFileSync(path, JSON.stringify({
    conversation_id: id, title, create_time: 1, update_time: 2, is_archived: false, current_node: "one",
    mapping: {
      root: { id: "root", parent: null, message: null },
      one: { id: "one", parent: "root", message: { author: { role: "user" }, content: { parts: ["hello"] }, metadata: {} } },
    },
  }));
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "overhaul-test-"));
  mkdirSync(join(root, "json"), { recursive: true });
  mkdirSync(join(root, "projects", "Project A", "json"), { recursive: true });
  conversationFile(join(root, "json", "one.json"), ID1, "General");
  conversationFile(join(root, "projects", "Project A", "json", "two.json"), ID2, "Project chat");
  writeFileSync(join(root, "projects", "Project A", "project-info.md"), "# Project A\n");
  writeFileSync(join(root, "export-summary.json"), JSON.stringify({
    total: 2, failed: 0, complete: true, dateFrom: null, dateTo: null,
    scope: { conversations: true, projectMetadata: true, attachments: false, formats: { json: true } },
    discoveredTotal: 2, skipped: 0, conversationIds: [ID1, ID2],
  }));
  const conversations = buildInventory(root).conversations.map((item) => ({ ...item, reasons: ["overhaul"] }));
  const projects = [{ projectName: "Project A", conversationCount: 1, sampleTitles: ["Project chat"] }];
  const catalogFile = join(root, "catalog.json");
  writeFileSync(catalogFile, JSON.stringify({ version: 1, kind: "conversation-maintenance-catalog", projects, conversations }));
  const inventoryPath = join(root, "inventory.json");
  writeFileSync(inventoryPath, JSON.stringify({
    version: 1, kind: "conversation-maintenance-inventory", warnings: [], catalogFile, projects, conversations,
  }));
  return { root, inventoryPath };
}

test("slice splits every conversation into exactly one even, reproducible part", () => {
  const { root, inventoryPath } = setup();
  try {
    const first = sliceInventory(inventoryPath, join(root, "a"), { parts: 2, seed: 7 });
    const second = sliceInventory(inventoryPath, join(root, "b"), { parts: 2, seed: 7 });
    assert.deepEqual(first.slices.map((s) => s.conversations), [1, 1]);
    const ids = readdirSync(join(root, "a")).flatMap((name) =>
      JSON.parse(readFileSync(join(root, "a", name), "utf8")).conversations.map((c) => c.conversationId));
    assert.deepEqual(ids.sort(), [ID1, ID2]);
    const layout = (dir) => readdirSync(dir).map((name) =>
      JSON.parse(readFileSync(join(dir, name), "utf8")).conversations[0].conversationId);
    assert.deepEqual(layout(join(root, "a")), layout(join(root, "b")));
    assert.equal(second.seed, 7);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("card validation requires exactly one well-formed card per conversation", () => {
  const { root, inventoryPath } = setup();
  try {
    const card = (id) => ({ id, topic: "주제", refs: [], state: "active", value: "high", harm: "none",
      why: "근거", title: null });
    const dir = join(root, "cards");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.json"), JSON.stringify([card(ID1)]));
    assert.throws(() => validateCards(inventoryPath, dir), /missing 1/);
    writeFileSync(join(dir, "b.json"), JSON.stringify([card(ID2), card(ID1)]));
    assert.throws(() => validateCards(inventoryPath, dir), /duplicated/);
    writeFileSync(join(dir, "b.json"), JSON.stringify([{ ...card(ID2), state: "bogus" }]));
    assert.throws(() => validateCards(inventoryPath, dir), /state is invalid/);
    writeFileSync(join(dir, "b.json"), JSON.stringify([card(ID2)]));
    assert.equal(validateCards(inventoryPath, dir).cards, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("assemble derives project actions and passes the proposal validator", () => {
  const { root, inventoryPath } = setup();
  try {
    const dir = join(root, "verdicts");
    mkdirSync(dir);
    writeFileSync(join(dir, "v.json"), JSON.stringify([
      { id: ID1, decision: "keep", title: "일반 대화 검토 — 제목과 프로젝트 정리", project: null, confidence: "high", why: "고유 결과" },
      { id: ID2, decision: "delete", title: "잡음 대화 — 삭제 후보", confidence: "high", why: "잡음" },
    ]));
    const { validation } = assembleProposal(inventoryPath, dir, join(root, "proposal.json"));
    assert.deepEqual(validation.decisionCounts, { keep: 1, delete: 1, undecided: 0 });
    const proposal = JSON.parse(readFileSync(join(root, "proposal.json"), "utf8"));
    assert.equal(proposal.items.find((i) => i.conversationId === ID1).suggestedProjectAction, "none");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a deletion candidate with a non-standard title needs a standard title in the proposal", () => {
  const { root, inventoryPath } = setup();
  try {
    const dir = join(root, "verdicts");
    mkdirSync(dir);
    writeFileSync(join(dir, "v.json"), JSON.stringify([
      { id: ID1, decision: "keep", title: "일반 대화 검토 — 제목과 프로젝트 정리", project: null, confidence: "high", why: "유지" },
      { id: ID2, decision: "delete", confidence: "high", why: "잡음" },
    ]));
    assert.throws(() => assembleProposal(inventoryPath, dir, join(root, "proposal.json")), /standard/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
