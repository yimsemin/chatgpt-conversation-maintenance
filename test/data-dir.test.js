import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { configuredDataDir, lockFilePath, resolveDataDir, runsDir, stateFilePath } from "../data-dir.js";

function appRootFixture() {
  return mkdtempSync(join(tmpdir(), "data-dir-"));
}

test("resolveDataDir defaults to <appRoot>/data and creates it", () => {
  const root = appRootFixture();
  try {
    const dataDir = resolveDataDir({ appRoot: root });
    assert.equal(dataDir, join(root, "data"));
    assert.equal(stateFilePath(dataDir), join(root, "data", "state.json"));
    assert.equal(lockFilePath(dataDir), join(root, "data", ".maintenance.lock"));
    assert.equal(runsDir(dataDir), join(root, "data", "runs"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit --data-dir value wins over the config file", () => {
  const root = appRootFixture();
  const custom = mkdtempSync(join(tmpdir(), "data-dir-custom-"));
  try {
    mkdirSync(join(root, ".local"), { recursive: true });
    writeFileSync(join(root, ".local", "config.json"), JSON.stringify({ dataDir: join(root, "from-config") }));
    assert.equal(configuredDataDir(root), join(root, "from-config"));
    assert.equal(resolveDataDir({ dataDir: custom, appRoot: root }), custom);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(custom, { recursive: true, force: true });
  }
});

test("the config file redirects the data folder, relative to appRoot", () => {
  const root = appRootFixture();
  try {
    mkdirSync(join(root, ".local"), { recursive: true });
    writeFileSync(join(root, ".local", "config.json"), JSON.stringify({ dataDir: "synced/chatgpt" }));
    assert.equal(resolveDataDir({ appRoot: root }), join(root, "synced", "chatgpt"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
