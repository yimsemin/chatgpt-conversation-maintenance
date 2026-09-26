import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_TRASH_PROJECT, configuredDataDir, configuredTrash, lockFilePath, resolveDataDir, runsDir } from "../src/data-dir.js";

function appRootFixture() {
  return mkdtempSync(join(tmpdir(), "data-dir-"));
}

test("resolveDataDir defaults to <appRoot>/data and creates it", () => {
  const root = appRootFixture();
  try {
    const dataDir = resolveDataDir({ appRoot: root });
    assert.equal(dataDir, join(root, "data"));
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

test("the trash project defaults to an automatic project and can be fixed by name or turned off", () => {
  const root = appRootFixture();
  try {
    assert.deepEqual(configuredTrash(root), { mode: "auto", name: DEFAULT_TRASH_PROJECT });
    mkdirSync(join(root, ".local"));
    const write = (trash) => writeFileSync(join(root, ".local", "config.json"), JSON.stringify({ trash }));
    write({ mode: "fixed", name: "  ♻️ 삭제후보  " });
    assert.deepEqual(configuredTrash(root), { mode: "fixed", name: "♻️ 삭제후보" });
    write({ mode: "none" });
    assert.deepEqual(configuredTrash(root), { mode: "none", name: "" });
    write({ mode: "auto", name: "무시됨" });
    assert.deepEqual(configuredTrash(root), { mode: "auto", name: DEFAULT_TRASH_PROJECT });
    // 이름이 없거나 주소·ID·너무 긴 값이면 정해 둔 프로젝트로 인정하지 않고 기본값으로 돌아간다.
    for (const name of [undefined, "", "https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project", "g-p-0123456789abcdef0123456789abcdef", "x".repeat(101)]) {
      write({ mode: "fixed", name });
      assert.deepEqual(configuredTrash(root), { mode: "auto", name: DEFAULT_TRASH_PROJECT });
    }
    write({ mode: "bogus" });
    assert.deepEqual(configuredTrash(root), { mode: "auto", name: DEFAULT_TRASH_PROJECT });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
