import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_ID, validateRemoteOperation, validateRemoteResult } from "../src/remote-ops.js";

const CID = "11111111-1111-4111-8111-111111111111";
const PID = `g-p-${"a".repeat(32)}`;

test("remote operations accept only fixed operations and parameters", () => {
  assert.equal(validateRemoteOperation({ op: "getConversation", params: { id: CID } }).op, "getConversation");
  assert.throws(() => validateRemoteOperation({ op: "fetch", params: { url: "https://example.com" } }), /Unsupported/);
  assert.throws(() => validateRemoteOperation({ op: "getConversation", params: { id: CID, url: "/x" } }), /unsupported fields/);
});

test("project IDs require g-p- followed by exactly 32 hexadecimal characters", () => {
  assert.equal(PROJECT_ID.test(PID), true);
  assert.equal(PROJECT_ID.test(`${PID}-slug`), false);
  assert.throws(() => validateRemoteOperation({ op: "moveConversation", params: { id: CID, projectId: `${PID}-slug` } }), /Project ID/);
});

test("patches cannot remove or arbitrarily move a conversation", () => {
  assert.throws(() => validateRemoteOperation({ op: "patchConversation", params: { id: CID, body: { gizmo_id: null } } }), /supported field/);
  assert.throws(() => validateRemoteOperation({ op: "patchConversation", params: { id: CID, body: { title: "x", is_visible: false } } }), /exactly one/);
});

test("remote results reject successful body snippets", () => {
  assert.deepEqual(validateRemoteResult({ ok: true, status: 200, data: { items: [] }, contentType: "application/json" }).data, { items: [] });
  assert.throws(() => validateRemoteResult({ ok: true, status: 200, data: {}, contentType: "application/json", bodySnippet: "secret" }), /cannot include/);
});

// 실제 ChatGPT 대화 ID 는 RFC 4122 버전 1~5 가 아니다. 버전·variant 를 제한하면
// 실제 계정의 모든 getConversation 이 거부된다(2026-09-12 실측, r9 장애 원인).
test("conversation IDs accept real ChatGPT IDs outside RFC 4122 versions and reject anything not 8-4-4-4-12 hexadecimal", () => {
  for (const id of [
    "6aa3d0e3-2eac-83e9-8c48-711ba461efde",
    "11111111-1111-4111-8111-111111111111",
    "ffffffff-ffff-ffff-ffff-ffffffffffff",
    "00000000-0000-0000-0000-000000000000",
  ]) {
    assert.equal(validateRemoteOperation({ op: "getConversation", params: { id } }).params.id, id);
  }
  // 그래도 8-4-4-4-12 16진수가 아닌 것은 모두 거부한다.
  for (const id of [
    "../../etc/passwd",
    "6aa3d0e3-2eac-83e9-8c48-711ba461efde/extra",
    "6aa3d0e3_2eac_83e9_8c48_711ba461efde",
    "6aa3d0e3-2eac-83e9-8c48-711ba461efd",
    "zzzzzzzz-2eac-83e9-8c48-711ba461efde",
    "",
  ]) {
    assert.throws(() => validateRemoteOperation({ op: "getConversation", params: { id } }),
      /Conversation ID is invalid/);
  }
});
