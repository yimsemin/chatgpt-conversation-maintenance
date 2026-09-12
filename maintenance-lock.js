#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assert } from "./assert.js";
import { lockFilePath, resolveDataDir } from "./data-dir.js";

// A single local lock file serializes the one-at-a-time maintenance work
// (baseline scans, checkpoints, routing sync and remote mutations) across the
// user's computers. It replaces the earlier Git-tag lock: the data folder is
// synced by the user's own tool, so the lock travels with it. A lock left
// behind by a crashed run is taken over automatically once it is stale.

export const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

function readHolder(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}

export function lockStatus({ dataDir, now = () => Date.now() } = {}) {
  const path = lockFilePath(dataDir);
  if (!existsSync(path)) return { locked: false, holder: null, stale: false };
  const holder = readHolder(path);
  const startedAt = Date.parse(holder?.acquiredAt || "") || 0;
  const stale = now() - startedAt > STALE_LOCK_MS;
  return { locked: true, holder, stale };
}

export function acquireLock({
  dataDir,
  device = hostname(),
  runId = randomUUID(),
  now = () => new Date(),
} = {}) {
  const path = lockFilePath(dataDir);
  const current = lockStatus({ dataDir, now: () => now().getTime() });
  if (current.locked && !current.stale) {
    const holder = current.holder || {};
    throw new Error(
      `maintenance lock held by ${holder.device || "unknown"} since ${holder.acquiredAt || "unknown time"} `
      + `(run ${holder.runId || "unknown"}); if that run is not active, clear it with `
      + `"node maintenance-lock.js release"`,
    );
  }
  if (current.locked && current.stale) {
    try { unlinkSync(path); } catch {}
  }
  const holder = {
    version: 1,
    runId,
    device,
    pid: process.pid,
    acquiredAt: now().toISOString(),
  };
  try {
    writeFileSync(path, `${JSON.stringify(holder, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("another maintenance run acquired the lock first; retry after it releases");
    }
    throw error;
  }
  return { locked: true, ...holder };
}

export function releaseLock({ dataDir } = {}) {
  const path = lockFilePath(dataDir);
  if (existsSync(path)) unlinkSync(path);
  return { locked: false };
}

export function assertLockHeld({ dataDir } = {}) {
  const status = lockStatus({ dataDir });
  assert(status.locked,
    'no maintenance lock is held; run "node maintenance-lock.js acquire" first');
  assert(!status.stale,
    'the maintenance lock is stale; re-acquire it with "node maintenance-lock.js acquire" before mutating');
  return { locked: true, holder: status.holder };
}

function usage() {
  return [
    "Usage:",
    "  node maintenance-lock.js status  [--data-dir <path>]",
    "  node maintenance-lock.js acquire [--data-dir <path>]",
    "  node maintenance-lock.js release [--data-dir <path>]",
    "",
    "Acquire before any ChatGPT mutation or baseline scan. Release once the verified",
    "state.json is written back to the data folder.",
  ].join("\n");
}

function parseDataDir(rest) {
  let dataDir = "";
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === "--data-dir") {
      dataDir = rest[++index];
      assert(dataDir !== undefined, "Missing value for --data-dir");
    } else throw new Error(usage());
  }
  return resolveDataDir({ dataDir });
}

function main(args) {
  const [command, ...rest] = args;
  assert(["status", "acquire", "release"].includes(command), usage());
  const dataDir = parseDataDir(rest);
  if (command === "status") console.log(JSON.stringify(lockStatus({ dataDir }), null, 2));
  else if (command === "acquire") console.log(JSON.stringify(acquireLock({ dataDir }), null, 2));
  else console.log(JSON.stringify(releaseLock({ dataDir }), null, 2));
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
