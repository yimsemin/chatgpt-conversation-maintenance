// 문서가 코드와 어긋나 낡아지는 것을 막는다: 상대 링크와, 문서가 이름을 대는 소스·테스트 파일이 실제로 있는지 본다.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = ["README.md", "AGENTS.md",
  ...readdirSync(join(ROOT, "docs")).map((name) => `docs/${name}`), ...readdirSync(join(ROOT, "templates")).map((name) => `templates/${name}`)]
  .filter((file) => file.endsWith(".md"));

test("relative links and file references in the documents point to existing files", () => {
  for (const file of DOCS) {
    const source = readFileSync(join(ROOT, file), "utf8");
    for (const match of source.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:/.test(match[1])) continue;
      assert.ok(existsSync(normalize(join(ROOT, dirname(file), match[1]))), `${file} links to missing ${match[1]}`);
    }
    for (const match of source.matchAll(/`((?:src|public\/assets|test|dev)\/[A-Za-z0-9_./-]+\.(?:js|html))`/g)) {
      assert.ok(existsSync(join(ROOT, match[1])), `${file} names missing ${match[1]}`);
    }
  }
});
