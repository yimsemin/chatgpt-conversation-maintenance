// 구조 규칙 시험: 모듈 사이의 의존 방향이 다시 엉키지 않게 한다. 규칙을 어기는 import 를 추가하면 여기서 실패한다.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const files = readdirSync(SRC).filter((name) => name.endsWith(".js"));

function importsOf(name) {
  const source = readFileSync(join(SRC, name), "utf8");
  return [...source.matchAll(/(?:from|import\()\s*"(\.\/[^"]+)"/g)].map((match) => normalize(match[1]));
}

const graph = new Map(files.map((name) => [name, importsOf(name)]));

test("root modules have no import cycles", () => {
  const state = new Map();
  const stack = [];
  function visit(name) {
    if (state.get(name) === 2) return;
    assert.notEqual(state.get(name), 1, `import cycle: ${[...stack, name].join(" -> ")}`);
    state.set(name, 1); stack.push(name);
    for (const dep of graph.get(name) || []) if (graph.has(dep)) visit(dep);
    stack.pop(); state.set(name, 2);
  }
  for (const name of graph.keys()) visit(name);
});

// 순수·하위 모듈은 서버·화면 계층을 알지 못한다.
const LOW_LEVEL = ["assert.js", "fs-json.js", "run-files.js", "phases.js", "summary.js", "session.js", "errors.js", "jobs.js",
  "trash.js", "catalog.js", "title-rules.js", "content-hash.js", "ids.js", "remote-ops.js",
  "relay-api.js", "classification-criteria.js", "proposal-validation.js", "decision-compile.js"];

test("low-level modules never import the web layer, the server or launcher", () => {
  for (const name of LOW_LEVEL) {
    for (const dep of graph.get(name) || []) {
      assert.ok(!/^(web-|maintenance-web|server|launcher|remote-relay)/.test(dep), `${name} must not import ${dep}`);
    }
  }
});

test("web modules only depend downwards", () => {
  const ORDER = ["web-common.js", "web-jobs.js", "web-views.js", "web-decisions.js", "web-workflows.js", "maintenance-web.js"];
  for (const [index, name] of ORDER.entries()) {
    for (const dep of graph.get(name) || []) {
      const depIndex = ORDER.indexOf(dep);
      if (depIndex !== -1) assert.ok(depIndex < index, `${name} must not import ${dep} (higher layer)`);
    }
  }
});

test("screen scripts import only screen modules or the shared pure modules", () => {
  const dir = join(ROOT, "public", "assets");
  for (const name of readdirSync(dir).filter((item) => item.endsWith(".js"))) {
    const source = readFileSync(join(dir, name), "utf8");
    for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
      assert.match(match[1], /^\/assets\/(shared\/)?[a-z0-9-]+\.js$/, `${name} imports ${match[1]}`);
    }
    assert.doesNotMatch(source, /\bfetch\(\s*["'`]https?:/, `${name} must not call external URLs`);
  }
});

// 화면 스크립트는 브라우저에서만 실행돼 다른 시험이 닿지 않는다. 다른 모듈이 내보내는 함수를 부르면서 import 하지 않은 실수를 잡는다
// (삭제후보 화면이 `$ is not defined` 로 열리지 않았던 문제).
test("screen scripts import every helper they call from another screen module", () => {
  const dir = join(ROOT, "public", "assets");
  const names = readdirSync(dir).filter((item) => item.endsWith(".js"));
  const sources = new Map(names.map((name) => [name, readFileSync(join(dir, name), "utf8")]));
  const exported = new Map();
  for (const [name, source] of sources) {
    for (const match of source.matchAll(/^export (?:async )?function (\$|\w+)|^export const (\$|\w+)/gm)) exported.set(match[1] || match[2], name);
  }
  for (const [name, source] of sources) {
    for (const [symbol, owner] of exported) {
      if (owner === name) continue;
      const escaped = symbol.replace(/\$/g, "\\$");
      if (!new RegExp(`(?<![\\w$.])${escaped}\\(`).test(source)) continue;
      const imported = new RegExp(`import\\s*\\{[^}]*(?<![\\w$])${escaped}(?![\\w$])[^}]*\\}`).test(source);
      const local = new RegExp(`(?:function\\s+${escaped}\\b|(?:const|let)\\s+${escaped}\\b|\\(${escaped}\\)\\s*=>|\\b${escaped}\\s*=>|[{,(]\\s*${escaped}\\s*[,})=])`).test(source);
      assert.ok(imported || local, `${name} calls ${symbol}() from ${owner} without importing it`);
    }
  }
});

test("environment variables are read only in config.js", () => {
  for (const name of files) {
    if (["config.js", "repo-check.js", "launcher.js", "data-dir.js", "app-version.js"].includes(name)) continue;
    assert.doesNotMatch(readFileSync(join(SRC, name), "utf8"), /process\.env\./, `${name} reads process.env directly`);
  }
});

// Node 쪽에서 ChatGPT 로 직접 나가는 HTTP 호출은 없다(TLS 핑거프린트로 막히고, 원격 호출은 브라우저가 한다).
// 로컬 앱을 부르는 launcher·server 의 fetch 와 서버를 여는 server 의 node:http 만 허용한다.
test("only the launcher and server call fetch (to the local app) and only the server imports node:http", () => {
  for (const name of files) {
    const source = readFileSync(join(SRC, name), "utf8");
    if (["launcher.js", "server.js"].includes(name)) {
      for (const match of source.matchAll(/\bfetch\(([^)]*)/g)) assert.match(match[1], /^`\$\{(?:URL|LOCAL_URL)\}\//, `${name} fetches ${match[1]}`);
    } else assert.doesNotMatch(source, /\bfetch\(/, `${name} calls fetch`);
    if (name !== "server.js") assert.doesNotMatch(source, /node:https?["']/, `${name} imports an HTTP module`);
  }
});
