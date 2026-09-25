import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeEta, createJobLog, formatDuration, trackProgress } from "../jobs.js";

test("eta is estimated from the rate since the phase started", () => {
  assert.equal(computeEta({ startedAtMs: 0, nowMs: 10000, index: 10, total: 110 }), 100);
  assert.equal(computeEta({ startedAtMs: 0, nowMs: 10000, index: 0, total: 110 }), null);
  assert.equal(computeEta({ startedAtMs: 0, nowMs: 10000, index: 110, total: 110 }), null);
  assert.equal(formatDuration(45), "45초");
  assert.equal(formatDuration(600), "10분");
  assert.equal(formatDuration(3900), "1시간 5분");
});

test("progress restarts its clock when the phase changes", () => {
  const job = {};
  trackProgress(job, { phase: "a", index: 1, total: 10 }, 1000);
  trackProgress(job, { phase: "a", index: 5, total: 10 }, 5000);
  assert.equal(job.progress.startedAtMs, 1000);
  trackProgress(job, { phase: "b", index: 1, total: 10 }, 9000);
  assert.equal(job.progress.startedAtMs, 9000);
});

test("job logs restore a finished job and close an interrupted one", () => {
  const dir = mkdtempSync(join(tmpdir(), "job-log-"));
  try {
    const log = createJobLog(dir);
    const done = { id: "aaaaaaaa-1", kind: "scan", workspace: "/w", createdAt: Date.now() - 2000, ok: true };
    log.open(done);
    log.event(done, { at: new Date().toISOString(), stage: "scan", message: "시작" });
    log.end(done);
    const crashed = { id: "bbbbbbbb-2", kind: "apply", workspace: "/w", createdAt: Date.now() - 1000 };
    log.open(crashed);
    log.event(crashed, { at: new Date().toISOString(), stage: "apply", message: "진행" });

    assert.equal(log.closeInterrupted(new Set()), 1);
    const recent = log.recent();
    assert.equal(recent.length, 2);
    const byId = Object.fromEntries(recent.map((item) => [item.id, item]));
    assert.equal(byId["aaaaaaaa-1"].ok, true);
    assert.equal(byId["bbbbbbbb-2"].interrupted, true);
    assert.equal(byId["bbbbbbbb-2"].ok, false);
    assert.match(byId["bbbbbbbb-2"].error.message, /이어서/);
    assert.equal(log.closeInterrupted(new Set()), 0);
    assert.equal(readdirSync(dir).length, 2);
    appendFileSync(join(dir, readdirSync(dir)[0]), "not json\n");
    assert.equal(log.recent().length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
