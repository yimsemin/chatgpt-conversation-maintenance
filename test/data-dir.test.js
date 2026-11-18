import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { withTemp } from "./support/tmp.js";

import { DEFAULT_TRASH_PROJECT, configuredDataDir, configuredTrash, lockFilePath, resolveDataDir, runsDir } from "../src/data-dir.js";

test("the data directory follows the default, config, then explicit override", async () => {
  await withTemp("data-dir-", (root) => {
    const dataDir = resolveDataDir({ appRoot: root });
    assert.equal(dataDir, join(root, "data"));
    assert.equal(existsSync(dataDir), true);
    assert.equal(lockFilePath(dataDir), join(root, "data", ".maintenance.lock"));
    assert.equal(runsDir(dataDir), join(root, "data", "runs"));

    const configured = join(root, "from-config");
    const custom = join(root, "explicit");
    mkdirSync(join(root, ".local"));
    writeFileSync(join(root, ".local", "config.json"), JSON.stringify({ dataDir: configured }));
    assert.equal(configuredDataDir(root), configured);
    assert.equal(resolveDataDir({ appRoot: root }), configured);
    assert.equal(resolveDataDir({ dataDir: custom, appRoot: root }), custom);
  });
});

test("the trash project defaults to an automatic project and can be fixed by name or turned off", async () => {
  await withTemp("data-dir-", (root) => {
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
  });
});
