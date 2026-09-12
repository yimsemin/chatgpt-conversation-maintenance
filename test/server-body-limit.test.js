import assert from "node:assert/strict";
import test from "node:test";

import { bodyLimitForPath } from "../server.js";

// 릴레이 결과에는 대화 본문 전체가 실린다. 2MB 한도로는 실제 대화가 거부되고,
// 결과가 브로커에 도달하지 못해 스캔이 "relay timed out"으로 실패했다(2026-09-12 실측).
test("relay results may carry a whole conversation while other bodies stay small", () => {
  const relay = bodyLimitForPath("/relay/result");
  const other = bodyLimitForPath("/maintenance/decisions");
  assert.ok(relay >= 32 * 1024 * 1024, "릴레이 결과 한도가 대화 본문에 부족합니다");
  assert.equal(other, 2 * 1024 * 1024);
  assert.equal(bodyLimitForPath("/relay/next"), other);
  assert.equal(bodyLimitForPath("/auth/session"), other);
});
