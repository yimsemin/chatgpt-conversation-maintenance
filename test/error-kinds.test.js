import test from "node:test";
import assert from "node:assert/strict";
import { KIND, isTransientFailure, withKind } from "../src/error-kinds.js";
import { explainError } from "../src/errors.js";

// 자동 재개 여부와 오류 안내는 문구가 아니라 오류 종류 코드로 정한다(번역·문구 수정이 동작을 바꾸지 않게).
test("transient failures and error explanations follow the error kind, not the message text", () => {
  for (const kind of [KIND.relayDown, KIND.relayTimeout, KIND.relayReplaced]) {
    assert.equal(isTransientFailure(withKind(new Error("임의의 문구"), kind)), true);
  }
  assert.equal(isTransientFailure(new Error("사용자가 작업을 중단했습니다")), false);
  assert.equal(isTransientFailure(withKind(new Error("Project not found: Project 429"), KIND.projectNotFound)), false);
  assert.equal(isTransientFailure(new Error("ChatGPT returned HTTP 503")), true);
  assert.equal(explainError("임의의 문구", null, KIND.relayTimeout).titleContent.key, "error.timeout.title");
  assert.equal(explainError("임의의 문구", null, KIND.relayDown).titleContent.key, "error.relayDown.title");
});
