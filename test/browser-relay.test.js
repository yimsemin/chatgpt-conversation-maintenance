import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { describeRemoteRequest } from "../src/remote-ops.js";

const bookmarklet = readFileSync(new URL("../public/bookmarklet.html", import.meta.url), "utf8");
// javascript: URL 은 저장·실행 과정에서 줄바꿈이 사라진다. r8 에서 executor 안에 둔
// `//` 라인 주석이 뒤쪽 코드를 전부 삼켜 북마클릿이 통째로 깨졌다(클릭해도 창이 열리지 않음).
// 아래 두 테스트가 같은 회귀를 막는다.

function executorSource() {
  const lines = bookmarklet.split("\n");
  const start = lines.findIndex((line) => line.includes("function executor("));
  assert.ok(start >= 0, "executor 원본을 찾지 못했습니다");
  // executor 의 닫는 중괄호만 2칸 들여쓰기다. 그 줄까지가 함수 본문이다.
  const end = lines.findIndex((line, index) => index > start && line === "  }");
  assert.ok(end > start, "executor 의 끝을 찾지 못했습니다");
  return lines.slice(start, end + 1).join("\n");
}

test("the bookmarklet still parses after a browser strips its newlines", () => {
  const collapsed = executorSource().replace(/\n\s*/g, " ");
  assert.doesNotMatch(collapsed, /\n/);
  assert.doesNotThrow(() => new Function(`return (${collapsed});`));
  // 줄바꿈을 지운 코드가 핵심 동작을 그대로 갖고 있는지 확인한다.
  assert.match(collapsed, /window\.open\(T, "chatgptMaintenance"\)/);
  assert.match(collapsed, /chatgpt-relay-v2-ack/);
  assert.match(collapsed, /chatgpt-relay-v2-ready/);
  assert.match(collapsed, /throw new Error\("Unsupported remote operation"\)/);
});

test("the generator refuses an executor that carries a line comment", () => {
  const start = bookmarklet.indexOf("  function inlineSource(");
  const end = bookmarklet.indexOf("  const code = `javascript:");
  const factory = new Function(`${bookmarklet.slice(start, end)} return inlineSource;`)();
  assert.throws(() => factory(function broken() { // eslint-disable-line
    // 이 주석이 생성 단계에서 걸려야 한다
    return 1;
  }), /라인 주석/);
  assert.doesNotThrow(() => factory(function fine() { return "https://example.test"; }));
});

// 북마클릿 실행기가 실제로 보내는 요청이 앱이 허용한 op 계약(describeRemoteRequest)과 같은지, 토큰이 페이지 밖으로 나가지 않는지 실행해 확인한다.
test("the page executor sends exactly the requests the app contract describes and never posts the token", async () => {
  const ORIGIN = "http://127.0.0.1:8523";
  const TOKEN = "test-token-not-real";
  const CID = "11111111-1111-4111-8111-111111111111";
  const PID = `g-p-${"a".repeat(32)}`;
  const calls = []; const posted = []; let listener = null;
  const chatgpt = { origin: "https://chatgpt.com" };
  const popup = { closed: false, focus() {}, postMessage: (message) => posted.push(message) };
  const fakeWindow = { open: () => popup, addEventListener: (type, fn) => { if (type === "message") listener = fn; }, removeEventListener() {} };
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {} });
    const data = url === "/api/auth/session" ? { accessToken: TOKEN, account: { id: "acct" } } : {};
    return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify(data), json: async () => data };
  };
  const make = new Function("location", "window", "alert", "fetch", "setInterval", "clearInterval", `return (${executorSource()});`);
  make(chatgpt, fakeWindow, () => {}, fakeFetch, () => 1, () => {})(ORIGIN, "relay-test");

  const operations = [
    { op: "getConversation", params: { id: CID } },
    { op: "listConversations", params: { offset: 100, limit: 100, archived: false } },
    { op: "listProjects", params: { cursor: "next", limit: 20 } },
    { op: "listProjectConversations", params: { projectId: PID, cursor: "", limit: 50 } },
    { op: "createProject", params: { name: "새 프로젝트", instructions: "" } },
    { op: "moveConversation", params: { id: CID, projectId: PID } },
    { op: "patchConversation", params: { id: CID, body: { title: "제목 — 결과" } } },
  ];
  for (const [index, operation] of operations.entries()) {
    calls.length = 0;
    listener({ origin: ORIGIN, source: popup, data: { type: "chatgpt-relay-v2-request", id: String(index), ...operation } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const expected = describeRemoteRequest(operation);
    const backend = calls.filter((call) => call.url !== "/api/auth/session");
    assert.equal(backend.length, 1, `${operation.op} makes one backend request`);
    assert.deepEqual({ method: backend[0].method, path: backend[0].url, body: backend[0].body }, expected, operation.op);
    assert.equal(backend[0].headers.Authorization, `Bearer ${TOKEN}`);
  }
  listener({ origin: ORIGIN, source: popup, data: { type: "chatgpt-relay-v2-request", id: "acct", op: "accountInfo", params: {} } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(posted.find((message) => message.id === "acct" && message.type === "chatgpt-relay-v2-result").result.data.accountId, "acct");
  assert.equal(JSON.stringify(posted).includes(TOKEN), false, "the access token is never posted to the app window");
  fakeWindow.__CHATGPT_MAINTENANCE_RELAY__?.stop?.();
});
