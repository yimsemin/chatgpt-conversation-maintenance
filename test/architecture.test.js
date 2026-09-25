// 구조 규칙 시험: 모듈 사이의 의존 방향이 다시 엉키지 않게 한다. 규칙을 어기는 import 를 추가하면 여기서 실패한다.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = readdirSync(ROOT).filter((name) => name.endsWith(".js"));

function importsOf(name) {
  const source = readFileSync(join(ROOT, name), "utf8");
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
  "parking.js", "catalog.js", "catalog-diff.js", "baseline.js", "title-rules.js", "content-hash.js", "ids.js", "remote-ops.js",
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

test("environment variables are read only in config.js", () => {
  for (const name of files) {
    if (["config.js", "repo-check.js", "launcher.js", "data-dir.js", "app-version.js"].includes(name)) continue;
    assert.doesNotMatch(readFileSync(join(ROOT, name), "utf8"), /process\.env\./, `${name} reads process.env directly`);
  }
});
