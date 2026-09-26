import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addTrashed, readTrash, removeTrashed } from "../trash.js";

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
