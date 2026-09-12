#!/usr/bin/env node

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_ROOT = dirname(fileURLToPath(import.meta.url));

// The data folder holds everything specific to one user's ChatGPT account:
// the incremental baseline (state.json), per-run artifacts (runs/) and the
// local maintenance lock. It never belongs in Git. The location defaults to
// <appRoot>/data but can be redirected so the user can point it at a synced
// folder (iCloud/Drive/Dropbox) of their choice.

export function configuredDataDir(appRoot = MODULE_ROOT) {
  try {
    const config = JSON.parse(readFileSync(join(appRoot, ".local", "config.json"), "utf8"));
    if (typeof config?.dataDir === "string" && config.dataDir.trim()) return config.dataDir.trim();
  } catch {}
  return "";
}

export function resolveDataDir({ dataDir = "", appRoot = MODULE_ROOT } = {}) {
  const requested = String(dataDir || "").trim() || configuredDataDir(appRoot) || join(appRoot, "data");
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(appRoot, requested);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  return absolute;
}

export function stateFilePath(dataDir) {
  return join(dataDir, "state.json");
}

export function runsDir(dataDir) {
  const dir = join(dataDir, "runs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function lockFilePath(dataDir) {
  return join(dataDir, ".maintenance.lock");
}
