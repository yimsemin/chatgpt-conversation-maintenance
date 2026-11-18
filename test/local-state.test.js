import assert from "node:assert/strict";
import test from "node:test";
import { withTemp } from "./support/tmp.js";

import { projectIdFromLink } from "../src/project-link.js";
import { readKnownProjects, writeKnownProjects } from "../src/known-projects.js";
import { addTrashed, readTrash, removeTrashed } from "../src/trash.js";
import { fakeProjectId } from "./support/fake-chatgpt.js";

test("trashed conversations are remembered with their reason and can be released", async () => {
  await withTemp("trash-", async (dir) => {
    assert.deepEqual(readTrash(dir), { version: 1, project: null, items: [] });
    addTrashed(dir, { project: "재테크", items: [
      { conversationId: "a", title: "가 — 결과", fromProject: "취미", reason: "저가치", intendedTarget: null },
      { conversationId: "b", title: "나 — 결과", fromProject: null, reason: "낡음", intendedTarget: "개발 도구" },
    ], now: () => new Date("2026-09-25T00:00:00Z") });
    let trash = readTrash(dir);
    assert.equal(trash.project, "재테크");
    assert.equal(trash.items.length, 2);
    assert.equal(trash.items[0].trashedAt, "2026-09-25T00:00:00.000Z");
    addTrashed(dir, { project: "재테크", items: [{ conversationId: "a", title: "가 — 결과", fromProject: "취미", reason: "다시", intendedTarget: null }] });
    assert.equal(readTrash(dir).items.length, 2);
    trash = removeTrashed(dir, ["a"]);
    assert.deepEqual(trash.items.map((item) => item.conversationId), ["b"]);
  });
});

test("refreshing known projects keeps earlier IDs and timestamps and sorts by the latest use", async () => {
  await withTemp("known-projects-", (root) => {
    const earlier = { name: "A", id: fakeProjectId(1), updatedAt: "2026-09-20T00:00:00Z" };
    writeKnownProjects(root, [earlier, { name: "B" }]);
    writeKnownProjects(root, [
      { name: "D" },
      { name: "A" },
      { name: "B", updatedAt: "2026-09-25T00:00:00Z" },
      { name: "C" },
    ]);
    assert.deepEqual(readKnownProjects(root).projects, [
      { name: "B", updatedAt: "2026-09-25T00:00:00Z" },
      earlier,
      { name: "D" },
      { name: "C" },
    ]);
  });
});

test("a project link yields the project id and anything else yields nothing", () => {
  const id = `g-p-${"0123456789abcdef".repeat(2)}`;
  assert.equal(projectIdFromLink(`https://chatgpt.com/g/${id}/project`), id);
  assert.equal(projectIdFromLink(`  https://chatgpt.com/g/${id}-이름-슬러그/project?x=1 `), id);
  assert.equal(projectIdFromLink(`https://chatgpt.com/g/${id.toUpperCase().replace("G-P-", "g-p-")}/project`), id);
  assert.equal(projectIdFromLink("https://chatgpt.com/c/77777777-7777-4777-8777-777777777777"), null);
  assert.equal(projectIdFromLink("g-p-short"), null);
  assert.equal(projectIdFromLink(""), null);
});
