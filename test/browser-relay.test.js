import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const bookmarklet = readFileSync(new URL("../public/bookmarklet.html", import.meta.url), "utf8");
// 유지관리 화면 쪽 릴레이 코드: 화면 페이지와 릴레이 클라이언트 스크립트.
const maintenance = readFileSync(new URL("../public/app.html", import.meta.url), "utf8")
  + readFileSync(new URL("../public/assets/relay-client.js", import.meta.url), "utf8")
  + readFileSync(new URL("../public/assets/app.js", import.meta.url), "utf8");

test("page executor keeps session credentials inside chatgpt.com and authenticates backend calls", () => {
  assert.match(bookmarklet, /fetch\("\/api\/auth\/session"/);
  assert.match(bookmarklet, /ChatGPT session lookup timed out after 15s/);
  assert.match(bookmarklet, /Authorization: `Bearer \$\{credentials\.token\}`/);
  assert.match(bookmarklet, /"ChatGPT-Account-Id": credentials\.accountId/);
  assert.doesNotMatch(bookmarklet, /postMessage\([^\n]*(accessToken|credentials\.token)/);
});

test("both browser surfaces display and exchange the same relay version", () => {
  assert.match(bookmarklet, /앱 버전 <code>__APP_RELEASE__<\/code>/);
  assert.match(maintenance, /<meta name="app-release" content="__APP_RELEASE__">/);
  assert.match(bookmarklet, /type: "chatgpt-relay-v2-ready", release: R, protocolVersion: V/);
  assert.match(maintenance, /JSON\.stringify\(\{ clientId, release, protocolVersion \}\)/);
  assert.match(maintenance, /북마클릿 업데이트 필요/);
  assert.match(bookmarklet, /chatgpt-relay-v2-request/);
  assert.match(maintenance, /chatgpt-relay-v2-request/);
  assert.doesNotMatch(bookmarklet, /"chatgpt-relay-request"/);
  assert.doesNotMatch(maintenance, /"chatgpt-relay-request"/);
});

test("page executor exposes only fixed operation branches", () => {
  assert.match(bookmarklet, /op === "listConversations"/);
  assert.match(bookmarklet, /op === "listProjects"/);
  assert.match(bookmarklet, /op === "patchConversation"/);
  assert.match(bookmarklet, /throw new Error\("Unsupported remote operation"\)/);
});

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

test("the page executor contains no line comments that a javascript: URL would swallow", () => {
  const withoutStrings = executorSource().replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, "");
  const offenders = withoutStrings.split("\n").filter((line) => line.trim().startsWith("//"));
  assert.deepEqual(offenders, []);
});

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
