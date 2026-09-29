import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  STALE_LOCK_MS,
  acquireLock,
  lockStatus,
  releaseLock,
} from "../src/maintenance-lock.js";
import { lockFilePath } from "../src/data-dir.js";

function dataDirFixture() {
  return mkdtempSync(join(tmpdir(), "maintenance-lock-"));
}

test("acquire writes a holder and release clears it", () => {
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

    assert.deepEqual(releaseLock({ dataDir }), { locked: false });
    assert.equal(lockStatus({ dataDir }).locked, false);
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

test("a lock whose process died on this computer is taken over at once, but a live one is not", () => {
  const dataDir = dataDirFixture();
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid; // 이미 끝난 프로세스의 pid
    const write = (pid) => writeFileSync(lockFilePath(dataDir),
      JSON.stringify({ version: 1, runId: "r", device: hostname(), pid, acquiredAt: new Date().toISOString() }));
    write(dead);
    assert.equal(lockStatus({ dataDir }).stale, true);
    assert.equal(acquireLock({ dataDir, runId: "run-2" }).runId, "run-2");
    write(process.ppid); // 살아 있는 다른 프로세스
    assert.equal(lockStatus({ dataDir }).stale, false);
    assert.throws(() => acquireLock({ dataDir }), /maintenance lock held/);
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
