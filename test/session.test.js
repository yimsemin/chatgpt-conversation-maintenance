import assert from "node:assert/strict";
import test from "node:test";

import { deriveStep, describeRelay } from "../session.js";

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
