import assert from "node:assert/strict";
import test from "node:test";

import { createRelayTrace } from "../relay-trace.js";

test("the trace keeps only fixed diagnostic fields and truncates identifiers", () => {
  const trace = createRelayTrace({ now: () => 1000 });
  const event = trace.record("post-to-page", {
    op: "listConversations",
    requestId: "abcdef01-2345-6789-abcd-ef0123456789",
    clientId: "11111111-2222-3333-4444-555555555555",
    status: 200,
    elapsedMs: 42,
  });
  assert.equal(event.requestId, "abcdef01");
  assert.equal(event.clientId, "11111111");
  assert.equal(event.op, "listConversations");
  assert.equal(event.status, 200);
});

test("the trace refuses unknown stages and non-string notes", () => {
  const trace = createRelayTrace();
  assert.equal(trace.record("exfiltrate", { op: "x" }), null);
  assert.equal(trace.list().length, 0);
  const event = trace.record("loop-error", { note: { secret: "token" }, status: "200" });
  assert.equal(event.note, null);
  assert.equal(event.status, null);
});

test("the trace caps its buffer", () => {
  const trace = createRelayTrace({ max: 3 });
  for (let index = 0; index < 10; index++) trace.record("enqueue", { op: "accountInfo" });
  assert.equal(trace.list().length, 3);
  assert.equal(trace.list().at(-1).seq, 10);
});
