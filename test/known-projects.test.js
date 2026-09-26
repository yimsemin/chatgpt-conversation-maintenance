import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readKnownProjects, rememberProjects } from "../known-projects.js";

test("known projects accept the old names-only file and remember newly used projects without dropping others", () => {
  const dir = mkdtempSync(join(tmpdir(), "known-projects-"));
  try {
    writeFileSync(join(dir, "known-projects.json"), JSON.stringify({ version: 1, names: ["A", "B"] }));
    assert.deepEqual(readKnownProjects(dir).projects.map((p) => p.name), ["A", "B"]);
    rememberProjects(dir, ["C", "A"]);
    assert.deepEqual(readKnownProjects(dir).projects.map((p) => p.name).sort(), ["A", "B", "C"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
