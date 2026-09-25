import assert from "node:assert/strict";
import test from "node:test";

import { explainError } from "../errors.js";

test("known failures become an explanation with a next action", () => {
  assert.match(explainError("Conversation changed during maintenance: x (빠른 검증 가정 위반 — 전체 검증으로 다시 실행하세요)").title, /다른 대화가 바뀐/);
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
