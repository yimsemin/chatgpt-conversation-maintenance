import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { withTemp } from "./support/tmp.js";

import { buildBrief, nextAction } from "../src/brief.js";

const NOW = () => Date.parse("2026-09-24T00:00:00.000Z");

test("writing a proposal hands the same run from the agent to the user for review", async () => {
  await withTemp("brief-", (root) => {
    const runDir = join(root, "data", "runs", "run-1");
    const scope = { kind: "project", projectNames: ["A"] };
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(root, ".local"));
    writeFileSync(join(root, ".local", "maintenance-web.json"), JSON.stringify({
      version: 1, runDir, phase: "awaiting-proposal", result: { scope },
    }));
    writeFileSync(join(runDir, "inventory.json"), JSON.stringify({
      counts: { candidates: 3 }, source: { mode: "scope", scope },
    }));
    writeFileSync(join(runDir, "review.json"), "{}");

    const before = buildBrief({ appRoot: root, now: NOW });
    assert.equal(before.run.candidates, 3);
    assert.equal(before.run.hasReview, true);
    assert.equal(before.next.actor, "agent");
    assert.match(before.next.text, /proposal\.json/);

    writeFileSync(join(runDir, "proposal.json"), "{}");
    const after = buildBrief({ appRoot: root, now: NOW });
    assert.equal(after.next.actor, "user");
    assert.match(after.next.text, /검토/);
  });
});

test("a live lock takes priority over other steps", () => {
  const action = nextAction({
    lock: { locked: true, stale: false },
    run: { phase: "awaiting-proposal", hasProposal: false },
  });
  assert.match(action.text, /잠금/);
});
