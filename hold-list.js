#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDataDir } from "./data-dir.js";

try { process.umask(0o077); } catch {}

const MODULE_ROOT = dirname(fileURLToPath(import.meta.url));
const KIND = "conversation-hold-list";

// The hold list parks conversations whose only maintenance reason is a
// non-standard title. They are proposed once; after the user has reviewed that
// run they move here so every later scan stops re-surfacing the same
// format-only candidate. Any real change (title, update time, archive state or
// project) releases the conversation back into the next scan. The file lives in
// the data folder next to state.json and is never committed.

export function holdListPath(dataDir) {
  return join(dataDir, "hold-list.json");
}

function emptyHoldList() {
  return { version: 1, kind: KIND, conversations: [] };
}

export function readHoldList(dataDir) {
  const path = holdListPath(dataDir);
  if (!existsSync(path)) return emptyHoldList();
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch { return emptyHoldList(); }
  if (parsed?.version !== 1 || parsed.kind !== KIND || !Array.isArray(parsed.conversations)) {
    return emptyHoldList();
  }
  const seen = new Set();
  const conversations = [];
  for (const item of parsed.conversations) {
    if (!item || typeof item.conversationId !== "string" || !item.conversationId) continue;
    if (seen.has(item.conversationId)) continue;
    seen.add(item.conversationId);
    conversations.push({
      conversationId: item.conversationId,
      title: typeof item.title === "string" ? item.title : null,
      updateTime: item.updateTime ?? null,
      isArchived: item.isArchived === true,
      projectName: item.projectName || null,
      heldAt: typeof item.heldAt === "string" ? item.heldAt : null,
    });
  }
  return { version: 1, kind: KIND, conversations };
}

export function writeHoldList(dataDir, list, now = () => new Date()) {
  const path = holdListPath(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const value = {
    version: 1,
    kind: KIND,
    updatedAt: now().toISOString(),
    conversations: [...list.conversations]
      .sort((left, right) => left.conversationId.localeCompare(right.conversationId)),
  };
  const partial = `${path}.partial-${randomUUID()}`;
  try {
    writeFileSync(partial, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(partial, path);
  } catch (error) {
    try { unlinkSync(partial); } catch {}
    throw error;
  }
  return value;
}

function updateMillis(updateTime) {
  if (typeof updateTime === "number" && Number.isFinite(updateTime)) {
    return updateTime > 1e12 ? updateTime : updateTime * 1000;
  }
  const parsed = Date.parse(updateTime || "");
  return Number.isFinite(parsed) ? parsed : null;
}

// A held entry only suppresses re-classification while the conversation is the
// exact same candidate it was parked as.
export function holdSignature({ title, updateTime, isArchived, projectName }) {
  return JSON.stringify([
    title ?? null,
    updateMillis(updateTime),
    isArchived === true,
    projectName || null,
  ]);
}

export function isHeld(holdList, catalogItem) {
  const entry = holdList.conversations.find(
    (item) => item.conversationId === catalogItem.conversationId);
  return Boolean(entry) && holdSignature(entry) === holdSignature(catalogItem);
}

export function holdEntry(catalogItem, now = () => new Date()) {
  return {
    conversationId: catalogItem.conversationId,
    title: catalogItem.title ?? null,
    updateTime: catalogItem.updateTime ?? null,
    isArchived: catalogItem.isArchived === true,
    projectName: catalogItem.projectName || null,
    heldAt: now().toISOString(),
  };
}

function usage() {
  return [
    "Usage:",
    "  node hold-list.js list [--data-dir <path>]",
    "  node hold-list.js remove <conversation-id> [--data-dir <path>]",
    "  node hold-list.js clear [--data-dir <path>]",
  ].join("\n");
}

function parseDataDir(values) {
  let dataDir = "";
  const positional = [];
  for (let index = 0; index < values.length; index++) {
    if (values[index] === "--data-dir") {
      dataDir = values[++index];
      if (dataDir === undefined) throw new Error("Missing value for --data-dir");
    } else positional.push(values[index]);
  }
  return { dataDir, positional };
}

function main(args) {
  const [command, ...values] = args;
  if (!["list", "remove", "clear"].includes(command)) throw new Error(usage());
  const { dataDir, positional } = parseDataDir(values);
  const resolved = resolveDataDir({ dataDir, appRoot: MODULE_ROOT });
  const list = readHoldList(resolved);
  if (command === "list") {
    console.log(JSON.stringify({
      path: holdListPath(resolved),
      count: list.conversations.length,
      conversations: list.conversations,
    }, null, 2));
    return;
  }
  if (command === "remove") {
    const id = positional[0];
    if (!id) throw new Error(usage());
    const kept = list.conversations.filter((item) => item.conversationId !== id);
    if (kept.length === list.conversations.length) throw new Error(`Not on the hold list: ${id}`);
    writeHoldList(resolved, { ...list, conversations: kept });
    console.log(JSON.stringify({ removed: id, remaining: kept.length }, null, 2));
    return;
  }
  writeHoldList(resolved, { ...list, conversations: [] });
  console.log(JSON.stringify({ cleared: list.conversations.length }, null, 2));
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
