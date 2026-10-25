import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { changelogForScreen, promote, releaseNotes, validateChangelog } from "../src/release-notes.js";

const BASE = `# 변경 이력

## [Unreleased]

### Added

- **새 기능.** 설명입니다.

### Fixed

- **버그 수정.** 고쳤습니다.

## [1.0.0] - 2026-10-30

### Added

- **최초 출시.** 시작합니다.
`;

test("the repository CHANGELOG follows the format and matches package.json", () => {
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  assert.deepEqual(validateChangelog(readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8"), { packageVersion: version }), []);
});

test("releasing promotes Unreleased, refuses a skipped bump and prints the notes with a compare link", () => {
  assert.deepEqual(validateChangelog(BASE, { packageVersion: "1.0.0" }), []);
  assert.throws(() => promote(BASE, "1.0.1", "2026-11-01"), /minor/);
  assert.throws(() => promote(BASE, "0.9.0", "2026-11-01"), /higher/);
  const next = promote(BASE, "1.1.0", "2026-11-01");
  assert.deepEqual(validateChangelog(next, { packageVersion: "1.1.0" }), []);
  assert.deepEqual(changelogForScreen(next).map((s) => s.version), ["1.1.0", "1.0.0"]);
  assert.match(releaseNotes(next, "1.1.0"), /compare\/v1\.0\.0\.\.\.v1\.1\.0/);
  assert.throws(() => promote(next, "1.2.0", "2026-11-02"), /no entries/);
  assert.match(validateChangelog(BASE.replace("### Fixed", "### Tweaked")).join("\n"), /unknown group/);
  assert.match(validateChangelog(BASE, { packageVersion: "1.0.1" }).join("\n"), /differs from the latest release/);
});
