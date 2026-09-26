import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { explainError } from "../src/errors.js";

test("known failures become an explanation with a next action", () => {
  assert.match(explainError("Backup title does not match abc").title, /제목이 바뀌어/);
  assert.match(explainError("ChatGPT update failed: HTTP 429").title, /429/);
  assert.match(explainError("ChatGPT page relay timed out: getConversation").title, /응답하지 않았습니다/);
  assert.match(explainError("ChatGPT relay page is not connected").action, /북마클릿/);
  assert.match(explainError("Uncertain in-progress receipt actions require manual review: a").action, /확인/);
  assert.match(explainError("사용자가 중단했습니다").title, /중단/);
});

test("unknown errors keep their first line and ask for the copied diagnostics", () => {
  const explained = explainError("Something odd happened\nstack trace");
  assert.equal(explained.title, "Something odd happened");
  assert.match(explained.action, /오류 복사/);
});

import { computeEta, createJobLog, formatDuration, trackProgress } from "../src/jobs.js";

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

import { deriveStep, describeRelay } from "../src/session.js";

test("the step follows the running job first, then the run files", () => {
  assert.equal(deriveStep({ activeJobKind: "apply", hasRun: true }), "apply");
  assert.equal(deriveStep({ activeJobKind: "scan" }), "scan");
  assert.equal(deriveStep({}), "scan");
  assert.equal(deriveStep({ hasRun: true, phase: "awaiting-proposal", hasProposal: false }), "proposal");
  assert.equal(deriveStep({ hasRun: true, phase: "awaiting-proposal", hasProposal: true }), "review");
  assert.equal(deriveStep({ hasRun: true, phase: "complete", hasReport: true }), "result");
  assert.equal(deriveStep({ hasRun: true, phase: "complete", hasReport: false }), "scan");
  // 결과 뒤에 끝난 읽기 전용 작업(확인·삭제후보 다시 확인)이 있으면 지난 결과 화면으로 돌아가지 않는다.
  assert.equal(deriveStep({ hasRun: true, phase: "complete", hasReport: true, resultSuperseded: true }), "scan");
});

test("relay status becomes a sentence with a next action", () => {
  assert.equal(describeRelay({ connected: false }).level, "bad");
  assert.equal(describeRelay({ connected: true, consecutiveFailures: 3 }).level, "warn");
  assert.equal(describeRelay({ connected: true, pending: 1, lastResultAgoMs: 60000 }).level, "warn");
  assert.equal(describeRelay({ connected: true, pending: 0, consecutiveFailures: 0 }).level, "ok");
});
