import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addParked, readParking, removeParked } from "../parking.js";

test("parked conversations are remembered with their reason and can be released", () => {
  const dir = mkdtempSync(join(tmpdir(), "parking-"));
  try {
    assert.deepEqual(readParking(dir), { version: 1, project: null, items: [] });
    addParked(dir, { project: "주식", items: [
      { conversationId: "a", title: "가 — 결과", fromProject: "오디오", reason: "저가치", intendedTarget: null },
      { conversationId: "b", title: "나 — 결과", fromProject: null, reason: "낡음", intendedTarget: "AI 개발도구" },
    ], now: () => new Date("2026-09-25T00:00:00Z") });
    let parking = readParking(dir);
    assert.equal(parking.project, "주식");
    assert.equal(parking.items.length, 2);
    assert.equal(parking.items[0].parkedAt, "2026-09-25T00:00:00.000Z");
    addParked(dir, { project: "주식", items: [{ conversationId: "a", title: "가 — 결과", fromProject: "오디오", reason: "다시", intendedTarget: null }] });
    assert.equal(readParking(dir).items.length, 2);
    parking = removeParked(dir, ["a"]);
    assert.deepEqual(parking.items.map((item) => item.conversationId), ["b"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
