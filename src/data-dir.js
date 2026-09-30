#!/usr/bin/env node

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// The data folder holds everything specific to one user's ChatGPT account:
// per-run artifacts and receipts (runs/), the trash-project list (trash.json), the job log (jobs/) and the
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

// 삭제후보를 어떻게 다룰지: 옮겨 둘 프로젝트(삭제후보 프로젝트)나 이동 없이 표시만 하는 방식.
// .local/config.json 의 "trash": { "mode": "auto" | "fixed" | "none", "name": "프로젝트 이름" }
//   auto  (기본) 이름이 DEFAULT_TRASH_PROJECT 인 삭제후보 프로젝트로 옮긴다. 없으면 새로 만든다.
//   fixed        name 으로 정한 프로젝트로 옮긴다. 그 프로젝트가 없으면 auto 와 같이 기본 이름의 삭제후보 프로젝트를 새로 만들어 옮긴다.
//   none         프로젝트로 옮기지 않고 삭제후보 표시만 한다(이미 프로젝트 안에 있는 대화는 API로 뺄 수 없어 직접 빼야 한다).
// 프로젝트 주소·ID는 받지 않고 이름만 쓴다.
export const DEFAULT_TRASH_PROJECT = "삭제후보";
const TRASH_MODES = ["auto", "fixed", "none"];

export function configuredTrash(appRoot = MODULE_ROOT) {
  const fallback = { mode: "auto", name: DEFAULT_TRASH_PROJECT };
  try {
    const trash = JSON.parse(readFileSync(join(appRoot, ".local", "config.json"), "utf8"))?.trash;
    if (!trash || !TRASH_MODES.includes(trash.mode)) return fallback;
    if (trash.mode === "none") return { mode: "none", name: "" };
    if (trash.mode === "auto") return fallback;
    const name = typeof trash.name === "string" ? trash.name.trim() : "";
    if (!name || name.length > 100 || /^https?:|g-p-/i.test(name)) return fallback;
    return { mode: "fixed", name };
  } catch {}
  return fallback;
}

export function resolveDataDir({ dataDir = "", appRoot = MODULE_ROOT } = {}) {
  const requested = String(dataDir || "").trim() || configuredDataDir(appRoot) || join(appRoot, "data");
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(appRoot, requested);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  return absolute;
}

export function runsDir(dataDir) {
  const dir = join(dataDir, "runs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function lockFilePath(dataDir) {
  return join(dataDir, ".maintenance.lock");
}
