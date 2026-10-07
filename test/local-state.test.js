import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { projectIdFromLink } from "../src/project-link.js";
import { readKnownProjects, sortByRecency, writeKnownProjects } from "../src/known-projects.js";
import { addTrashed, readTrash, removeTrashed } from "../src/trash.js";

test("trashed conversations are remembered with their reason and can be released", () => {
  const dir = mkdtempSync(join(tmpdir(), "trash-"));
  try {
    assert.deepEqual(readTrash(dir), { version: 1, project: null, items: [] });
    addTrashed(dir, { project: "주식", items: [
      { conversationId: "a", title: "가 — 결과", fromProject: "오디오", reason: "저가치", intendedTarget: null },
      { conversationId: "b", title: "나 — 결과", fromProject: null, reason: "낡음", intendedTarget: "AI 개발도구" },
    ], now: () => new Date("2026-09-25T00:00:00Z") });
    let trash = readTrash(dir);
    assert.equal(trash.project, "주식");
    assert.equal(trash.items.length, 2);
    assert.equal(trash.items[0].trashedAt, "2026-09-25T00:00:00.000Z");
    addTrashed(dir, { project: "주식", items: [{ conversationId: "a", title: "가 — 결과", fromProject: "오디오", reason: "다시", intendedTarget: null }] });
    assert.equal(readTrash(dir).items.length, 2);
    trash = removeTrashed(dir, ["a"]);
    assert.deepEqual(trash.items.map((item) => item.conversationId), ["b"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("known projects are listed most recently used first and keep the order ChatGPT gave when no time is known", () => {
  const sorted = sortByRecency([{ name: "B" }, { name: "A", updatedAt: "2026-09-01T00:00:00Z" }, { name: "C", updatedAt: "2026-09-20T00:00:00Z" }, { name: "D" }]);
  assert.deepEqual(sorted.map((p) => p.name), ["C", "A", "B", "D"]);
  const root = mkdtempSync(join(tmpdir(), "known-projects-"));
  try {
    writeKnownProjects(root, [{ name: "X", updatedAt: "2026-09-20T00:00:00Z" }, { name: "Y" }]);
    writeKnownProjects(root, [{ name: "Y", updatedAt: "2026-09-25T00:00:00Z" }, { name: "X" }]);
    const known = readKnownProjects(root);
    assert.deepEqual(known.projects, [{ name: "Y", updatedAt: "2026-09-25T00:00:00Z" }, { name: "X", updatedAt: "2026-09-20T00:00:00Z" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a project link yields the project id and anything else yields nothing", () => {
  const id = `g-p-${"0123456789abcdef".repeat(2)}`;
  assert.equal(projectIdFromLink(`https://chatgpt.com/g/${id}/project`), id);
  assert.equal(projectIdFromLink(`  https://chatgpt.com/g/${id}-이름-슬러그/project?x=1 `), id);
  assert.equal(projectIdFromLink(`https://chatgpt.com/g/${id.toUpperCase().replace("G-P-", "g-p-")}/project`), id);
  assert.equal(projectIdFromLink("https://chatgpt.com/c/6ab604d8-ab80-8191-aadad3877240"), null);
  assert.equal(projectIdFromLink("g-p-short"), null);
  assert.equal(projectIdFromLink(""), null);
});

test("the known project list keeps the project id across later writes that do not carry it", () => {
  const root = mkdtempSync(join(tmpdir(), "known-projects-id-"));
  try {
    writeKnownProjects(root, [{ name: "P", id: `g-p-${"a".repeat(32)}` }]);
    writeKnownProjects(root, [{ name: "P", updatedAt: "2026-09-20T00:00:00Z" }]);
    assert.equal(readKnownProjects(root).projects[0].id, `g-p-${"a".repeat(32)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
