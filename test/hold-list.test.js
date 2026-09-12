import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  holdEntry,
  holdListPath,
  holdSignature,
  isHeld,
  readHoldList,
  writeHoldList,
} from "../hold-list.js";

const ID1 = "11111111-1111-4111-8111-111111111111";

function item(overrides = {}) {
  return {
    conversationId: ID1,
    title: "단일 제목",
    updateTime: 1000,
    isArchived: false,
    projectName: "Project A",
    ...overrides,
  };
}

test("an absent hold list reads as empty and round-trips through write", () => {
  const dir = mkdtempSync(join(tmpdir(), "hold-list-test-"));
  try {
    assert.deepEqual(readHoldList(dir).conversations, []);
    writeHoldList(dir, { conversations: [holdEntry(item(), () => new Date("2026-08-30T00:00:00Z"))] });
    assert.equal(existsSync(holdListPath(dir)), true);
    const list = readHoldList(dir);
    assert.equal(list.conversations.length, 1);
    assert.equal(list.conversations[0].conversationId, ID1);
    assert.equal(list.conversations[0].heldAt, "2026-08-30T00:00:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isHeld matches only while title, update time, archive state and project are unchanged", () => {
  const list = { conversations: [holdEntry(item())] };
  assert.equal(isHeld(list, item()), true);
  assert.equal(isHeld(list, item({ title: "다른 제목" })), false);
  assert.equal(isHeld(list, item({ updateTime: 2000 })), false);
  assert.equal(isHeld(list, item({ projectName: "Project B" })), false);
  assert.equal(isHeld(list, item({ isArchived: true })), false);
  assert.equal(isHeld({ conversations: [] }, item()), false);
});

test("hold signature treats epoch seconds and milliseconds alike", () => {
  assert.equal(
    holdSignature(item({ updateTime: 1_700_000_000 })),
    holdSignature(item({ updateTime: 1_700_000_000_000 })),
  );
  assert.notEqual(
    holdSignature(item({ updateTime: 1_700_000_000 })),
    holdSignature(item({ updateTime: 1_700_000_001 })),
  );
});

test("a malformed hold list file reads as empty rather than throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "hold-list-bad-test-"));
  try {
    writeFileSync(holdListPath(dir), "{ not json");
    assert.deepEqual(readHoldList(dir).conversations, []);
    writeFileSync(holdListPath(dir), JSON.stringify({ version: 2, kind: "other", conversations: [] }));
    assert.deepEqual(readHoldList(dir).conversations, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("write sorts entries and drops duplicates on the next read", () => {
  const dir = mkdtempSync(join(tmpdir(), "hold-list-dedupe-test-"));
  try {
    writeFileSync(holdListPath(dir), JSON.stringify({
      version: 1,
      kind: "conversation-hold-list",
      conversations: [item(), item({ title: "second copy" })],
    }));
    const list = readHoldList(dir);
    assert.equal(list.conversations.length, 1);
    assert.equal(list.conversations[0].title, "단일 제목");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
