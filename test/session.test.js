import assert from "node:assert/strict";
import test from "node:test";

import { deriveStep, describeBaseline, describeRelay } from "../session.js";

test("the step follows the running job first, then the run files", () => {
  assert.equal(deriveStep({ activeJobKind: "apply", hasRun: true }), "apply");
  assert.equal(deriveStep({ activeJobKind: "scan" }), "scan");
  assert.equal(deriveStep({}), "scan");
  assert.equal(deriveStep({ hasRun: true, phase: "awaiting-proposal", hasProposal: false }), "proposal");
  assert.equal(deriveStep({ hasRun: true, phase: "awaiting-proposal", hasProposal: true }), "review");
  assert.equal(deriveStep({ hasRun: true, phase: "complete", hasReport: true }), "result");
  assert.equal(deriveStep({ hasRun: true, phase: "complete", hasReport: false }), "scan");
  // 검증·기준선 확정처럼 결과 뒤에 끝난 읽기 전용 작업이 있으면 지난 결과 화면으로 돌아가지 않는다.
  assert.equal(deriveStep({ hasRun: true, phase: "complete", hasReport: true, resultSuperseded: true }), "scan");
});

test("relay status becomes a sentence with a next action", () => {
  assert.equal(describeRelay({ connected: false }).level, "bad");
  assert.equal(describeRelay({ connected: true, consecutiveFailures: 3 }).level, "warn");
  assert.equal(describeRelay({ connected: true, pending: 1, lastResultAgoMs: 60000 }).level, "warn");
  assert.equal(describeRelay({ connected: true, pending: 0, consecutiveFailures: 0 }).level, "ok");
});

test("baseline freshness flags week-old baselines", () => {
  const now = Date.parse("2026-09-25T00:00:00Z");
  assert.equal(describeBaseline({ generatedAt: "2026-09-24T00:00:00Z" }, now).stale, false);
  assert.equal(describeBaseline({ generatedAt: "2026-09-10T00:00:00Z" }, now).stale, true);
  assert.equal(describeBaseline({}, now).stale, true);
});
