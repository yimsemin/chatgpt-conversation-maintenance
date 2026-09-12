import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  STALE_LOCK_MS,
  acquireLock,
  assertLockHeld,
  lockStatus,
  releaseLock,
} from "../maintenance-lock.js";
import { lockFilePath } from "../data-dir.js";

function dataDirFixture() {
  return mkdtempSync(join(tmpdir(), "maintenance-lock-"));
}

test("acquire writes a holder, assertLockHeld passes, release clears it", () => {
  const dataDir = dataDirFixture();
  try {
    assert.equal(lockStatus({ dataDir }).locked, false);
    const held = acquireLock({ dataDir, device: "macbook", runId: "run-1" });
    assert.equal(held.locked, true);
    assert.equal(held.device, "macbook");

    const status = lockStatus({ dataDir });
    assert.equal(status.locked, true);
    assert.equal(status.stale, false);
    assert.equal(status.holder.runId, "run-1");
    assert.equal(assertLockHeld({ dataDir }).locked, true);

    assert.deepEqual(releaseLock({ dataDir }), { locked: false });
    assert.equal(lockStatus({ dataDir }).locked, false);
    assert.throws(() => assertLockHeld({ dataDir }), /no maintenance lock/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a live lock blocks a second acquire", () => {
  const dataDir = dataDirFixture();
  try {
    acquireLock({ dataDir, device: "macbook", runId: "run-1" });
    assert.throws(() => acquireLock({ dataDir, device: "desktop", runId: "run-2" }),
      /held by macbook/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a stale lock is taken over automatically", () => {
  const dataDir = dataDirFixture();
  try {
    const old = new Date(Date.now() - STALE_LOCK_MS - 60_000).toISOString();
    writeFileSync(lockFilePath(dataDir),
      JSON.stringify({ version: 1, runId: "crashed", device: "old-host", acquiredAt: old }));
    assert.equal(lockStatus({ dataDir }).stale, true);

    const held = acquireLock({ dataDir, device: "macbook", runId: "run-2" });
    assert.equal(held.runId, "run-2");
    assert.equal(JSON.parse(readFileSync(lockFilePath(dataDir), "utf8")).device, "macbook");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
