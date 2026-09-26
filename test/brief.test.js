import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildBrief, formatBrief, nextAction } from "../brief.js";

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

test("without a run the next step is choosing a scope on the screen", () => {
  const { root } = fixture();
  try {
    const brief = buildBrief({ appRoot: root, now: NOW });
    assert.equal(brief.run, null);
    assert.equal(brief.next.actor, "user");
    assert.match(brief.next.text, /조사 범위/);
    assert.match(formatBrief(brief), /최근 실행: 없음/);
    assert.doesNotMatch(formatBrief(brief), /기준선/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the last run shows its scope", () => {
  const { root } = fixture({ pointer: { phase: "awaiting-proposal" }, files: ["review.json"] });
  try {
    assert.match(formatBrief(buildBrief({ appRoot: root, now: NOW })), /범위 프로젝트 A/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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

test("a run made before scopes existed is ignored", () => {
  const { root } = fixture({ pointer: { phase: "awaiting-proposal", result: { counts: { candidates: 130 } } }, files: ["review.json"] });
  try {
    const brief = buildBrief({ appRoot: root, now: NOW });
    assert.equal(brief.run, null);
    assert.match(brief.next.text, /조사 범위/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
