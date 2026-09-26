import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { scanMaintenanceRun } from "../scan.js";
import { createRelayApi, createRelayBroker } from "../relay-api.js";
import { describeRemoteRequest } from "../remote-ops.js";

const PROJECT_ID = `g-p-${"a".repeat(32)}`;
// 실제 ChatGPT 대화 ID 모양을 쓴다(버전 니블이 RFC 4122 범위 밖). 합성 UUID 만 쓰면
// r9 장애(실제 ID 가 검증에서 거부됨)를 통합 테스트가 놓친다.
const KNOWN = "6aa3d0e3-2eac-83e9-8c48-711ba461efde";
const FRESH = "7b04e1f4-3fbd-94fa-9d59-822cb572f0ef";

// 합성 페이지 실행기. 실제 ChatGPT를 부르지 않고 op별 고정 응답만 돌려준다.
function fakePage(served) {
  const json = (data) => ({ ok: true, status: 200, data, contentType: "application/json" });
  return (op, params) => {
    // 앱이 보낸 op가 페이지의 고정 경로 표와 어긋나지 않는지 같이 확인한다.
    served.push({ op, path: describeRemoteRequest({ op, params }).path });
    if (op === "listProjects") {
      return json({ items: [{ gizmo: { id: PROJECT_ID, display: { name: "조사" } } }] });
    }
    if (op === "listProjectConversations") {
      return json({ items: [{ id: KNOWN, title: "기존 주제 — 정리 결과",
        update_time: "2026-09-01T00:00:00.000Z", is_archived: false }], cursor: "" });
    }
    if (op === "listConversations") {
      if (params.archived || params.offset > 0) return json({ items: [], total: 2 });
      return json({ items: [
        { id: KNOWN, title: "기존 주제 — 정리 결과", update_time: "2026-09-01T00:00:00.000Z",
          is_archived: false, gizmo_id: PROJECT_ID },
        { id: FRESH, title: "새 대화 제목", update_time: "2026-09-10T00:00:00.000Z",
          is_archived: false, gizmo_id: null },
      ], total: 2 });
    }
    if (op === "getConversation") {
      // 실제 대화 본문은 수 MB 가 될 수 있다. 작은 픽스처만 쓰면 릴레이 본문 한도 회귀를 놓친다.
      const long = "가".repeat(600000);
      return json({ conversation_id: params.id, id: params.id, title: "새 대화 제목",
        gizmo_id: null, is_visible: true, conversation_template_id: null,
        current_node: "n2",
        mapping: {
          n1: { id: "n1", parent: null, message: { author: { role: "user" },
            content: { content_type: "text", parts: [long] } } },
          n2: { id: "n2", parent: "n1", message: { author: { role: "assistant" },
            content: { content_type: "text", parts: ["합성 응답"] } } },
        } });
    }
    throw new Error(`unexpected op ${op}`);
  };
}

// 브로커의 대기열을 합성 페이지가 소비하게 이어 붙인다. 유지관리 창이 하는 일과 같다.
function pumpRelay(broker, clientId, handle) {
  let stopped = false;
  (async () => {
    while (!stopped) {
      const { request } = broker.next(clientId);
      if (!request) { await new Promise((resolve) => setTimeout(resolve, 1)); continue; }
      broker.complete(clientId, request.id, handle(request.op, request.params));
    }
  })();
  return () => { stopped = true; };
}

test("a scan completes through the relay without any direct Node HTTP call", async () => {
  const root = mkdtempSync(join(tmpdir(), "relay-scan-"));
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });

  const clientId = "33333333-3333-4333-8333-333333333333";
  const broker = createRelayBroker({ timeoutMs: 5000 });
  broker.connect(clientId);
  const served = [];
  const stop = pumpRelay(broker, clientId, fakePage(served));
  const api = createRelayApi({ broker, requestDelayMs: 0, sleep: async () => {} });

  try {
    const result = await scanMaintenanceRun({ runDir, api, scope: { kind: "unassigned" } });
    const inventory = JSON.parse(readFileSync(result.inventoryPath, "utf8"));
    assert.deepEqual(inventory.warnings, []);
    assert.deepEqual(inventory.conversations.map((item) => item.conversationId), [FRESH]);
    assert.equal(inventory.conversations[0].projectName, null);
  } finally {
    stop();
    rmSync(root, { recursive: true, force: true });
  }

  // 페이지가 실제로 고정 경로만 받았는지 확인한다.
  assert.deepEqual([...new Set(served.map((entry) => entry.op))].sort(),
    ["getConversation", "listConversations", "listProjectConversations", "listProjects"]);
  for (const entry of served) {
    assert.match(entry.path, /^\/(backend-api|api)\//);
    assert.doesNotMatch(entry.path, /^https?:/);
  }
  assert.equal(broker.trace.list().filter((event) => event.stage === "result-accepted").length, served.length);
});
