import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildBrief, nextAction } from "../src/brief.js";

function fixture({ pointer = null, files = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "brief-"));
  const dataDir = join(root, "data");
  const runDir = join(dataDir, "runs", "run-1");
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(root, ".local"), { recursive: true });
  if (pointer) {
    writeFileSync(join(root, ".local", "maintenance-web.json"), JSON.stringify({
      version: 1, runDir, result: { scope: { kind: "project", projectNames: ["A"] } }, ...pointer,
    }));
  }
  writeFileSync(join(runDir, "inventory.json"), JSON.stringify({ counts: { candidates: 3 }, source: { mode: "scope", scope: { kind: "project", projectNames: ["A"] } } }));
  for (const name of files) writeFileSync(join(runDir, name), "{}");
  return { root, dataDir };
}

const NOW = () => Date.parse("2026-09-24T00:00:00.000Z");

test("awaiting proposal hands the classification to the agent", () => {
  const { root } = fixture({ pointer: { phase: "awaiting-proposal" }, files: ["review.json"] });
  try {
    const brief = buildBrief({ appRoot: root, now: NOW });
    assert.equal(brief.run.candidates, 3);
    assert.equal(brief.run.hasReview, true);
    assert.equal(brief.next.actor, "agent");
    assert.match(brief.next.text, /proposal\.json/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a written proposal returns the next step to the user", () => {
  const { root } = fixture({ pointer: { phase: "awaiting-proposal" }, files: ["review.json", "proposal.json"] });
  try {
    const brief = buildBrief({ appRoot: root, now: NOW });
    assert.equal(brief.next.actor, "user");
    assert.match(brief.next.text, /검토/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a live lock takes priority over other steps", () => {
  const action = nextAction({
    lock: { locked: true, stale: false },
    run: { phase: "awaiting-proposal", hasProposal: false },
  });
  assert.match(action.text, /잠금/);
});
