import { test } from "node:test";
import assert from "node:assert/strict";

import { findRepoIssues, personalPathPatterns } from "../src/repo-check.js";

const FAKE_STAT = { isFile: () => true, size: 12 };
function checkOne(path, text, options = {}) {
  return findRepoIssues([path], {
    readFile: () => text,
    statFile: () => FAKE_STAT,
    ...options,
  });
}

test("flags an account's personal home path, even a different account's home shape", () => {
  // Built at runtime so this test file never stores a real personal path.
  const home = "/Users/" + "realdev";
  const leaked = ["export const CACHE = ", JSON.stringify(home + "/cache"), ";"].join("");
  const errors = checkOne("src/config.js", leaked, { secretPatterns: [...personalPathPatterns(home)] });
  assert.ok(errors.some((e) => e.includes("personal")), errors.join("; "));

  const linux = personalPathPatterns("/home/" + "buildbot42");
  const line = ["log('", "/home/", "buildbot42", "/project/run')"].join("");
  assert.ok(checkOne("scripts/run.js", line, { secretPatterns: linux }).some((e) => e.includes("personal Linux home path")));
});

test("ignores documentation placeholder paths", () => {
  const patterns = personalPathPatterns("/Users/" + "realdev");
  const docs = "예: `/Users/you/chatgpt-archive` 또는 `C:\\Users\\<name>\\chatgpt-archive`";
  assert.deepEqual(checkOne("README.md", docs, { secretPatterns: patterns }), []);
});

test("returns no personal patterns for placeholder / CI account names", () => {
  for (const home of ["/Users/runner", "/home/ubuntu", "/root", "/Users/you"]) {
    assert.deepEqual(personalPathPatterns(home), [], home);
  }
});

test("still catches static secret shapes", () => {
  const key = "sk-" + "A".repeat(28);
  assert.ok(checkOne("lib/x.js", `const k = "${key}";`).some((e) => e.includes("OpenAI-style secret key")));
  // Assembled at runtime so this file holds no literal key marker.
  const dashes = "-".repeat(5);
  const pem = `${dashes}BEGIN OPENSSH PRIVATE KEY${dashes}\nabc\n${dashes}END OPENSSH PRIVATE KEY${dashes}`;
  assert.ok(checkOne("id_ed25519.txt", pem).some((e) => e.includes("private key")));
});

test("flags forbidden local paths", () => {
  assert.ok(checkOne("data/state.json", "{}").some((e) => e.includes("forbidden")));
  assert.ok(checkOne(".local/config.json", "{}").some((e) => e.includes("forbidden")));
});

test("flags case-insensitive path collisions", () => {
  const errors = findRepoIssues(["src/Thing.js", "src/thing.js"], {
    readFile: () => "",
    statFile: () => FAKE_STAT,
    secretPatterns: [],
  });
  assert.ok(errors.some((e) => e.includes("conflicts by case")));
});
