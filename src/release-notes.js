// CHANGELOG.md 검증·릴리스 승격·릴리스 노트 출력. 작성 기준은 docs/RELEASE_NOTES.md, 절차는 docs/GIT.md.
//
//   node src/release-notes.js check                       형식과 버전 일치 검사
//   node src/release-notes.js release <X.Y.Z> [--date D]  [Unreleased]를 릴리스로 승격하고 package.json 버전을 올림
//   node src/release-notes.js notes <X.Y.Z>               GitHub Release 본문 출력
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./assert.js";
import { REPO_URL } from "./app-version.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECTION = /^## \[(Unreleased|\d+\.\d+\.\d+)\](?: - (\d{4}-\d{2}-\d{2}))?\s*$/;
const ENTRY = /^- \*\*(.+?)\*\*\s*(.*)$/;
export const GROUPS = { Added: "추가된 기능", Changed: "달라진 점", Deprecated: "곧 사라질 기능", Removed: "사라진 기능", Fixed: "고친 문제", Security: "보안" };
const MAX_ENTRY_LENGTH = 200;

const compare = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

export function parseChangelog(text) {
  const sections = [];
  let current = null;
  for (const line of String(text).replace(/\r\n/g, "\n").split("\n")) {
    const match = SECTION.exec(line);
    if (match) { current = { version: match[1], date: match[2] || null, lines: [] }; sections.push(current); }
    else if (current) current.lines.push(line);
  }
  return sections.map((section) => ({ ...section, ...parseGroups(section.lines) }));
}

function parseGroups(lines) {
  const groups = [], stray = [];
  let group = null;
  for (const line of lines) {
    const heading = /^### (.+?)\s*$/.exec(line);
    if (heading) { group = { name: heading[1], entries: [] }; groups.push(group); }
    else if (line.trim()) {
      const entry = ENTRY.exec(line);
      if (group && entry) group.entries.push({ title: entry[1].replace(/[.。]$/, ""), body: entry[2], text: line.slice(2) });
      else stray.push(line.trim());
    }
  }
  return { groups, stray };
}

const entryCount = (section) => section.groups.reduce((sum, group) => sum + group.entries.length, 0);

export function validateChangelog(text, { packageVersion } = {}) {
  const errors = [];
  const sections = parseChangelog(text);
  if (!sections.length || sections[0].version !== "Unreleased") errors.push("The first section must be `## [Unreleased]`.");
  const released = sections.filter((section) => section.version !== "Unreleased");
  const announced = new Set();
  for (const [index, section] of sections.entries()) {
    const label = `[${section.version}]`;
    if (section.version === "Unreleased" && index !== 0) errors.push("`## [Unreleased]` must appear once, at the top.");
    if (section.version !== "Unreleased" && !section.date) errors.push(`${label} has no date.`);
    if (index > 1 && compare(sections[index - 1].version, section.version) <= 0) errors.push(`${label} must be lower than the version above it.`);
    section.stray.forEach((line) => errors.push(`${label} line outside the entry format: ${line}`));
    let last = -1;
    const names = Object.keys(GROUPS);
    for (const group of section.groups) {
      const at = names.indexOf(group.name);
      if (at === -1) errors.push(`${label} unknown group \`### ${group.name}\`.`);
      else if (at <= last) errors.push(`${label} group order or duplicate: \`### ${group.name}\`.`);
      else last = at;
      if (!group.entries.length) errors.push(`${label} empty group \`### ${group.name}\`.`);
      for (const entry of group.entries) {
        if (entry.text.length > MAX_ENTRY_LENGTH) errors.push(`${label} entry longer than ${MAX_ENTRY_LENGTH} characters: ${entry.title}`);
      }
    }
  }
  // 오래된 릴리스부터 보며 같은 제목을 Added 로 두 번 공지하지 않았는지 본다.
  for (const section of [...sections].reverse()) {
    for (const group of section.groups.filter((item) => item.name === "Added")) {
      for (const entry of group.entries) {
        const key = entry.title.toLowerCase();
        if (announced.has(key)) errors.push(`[${section.version}] "${entry.title}" was already announced as Added.`);
        announced.add(key);
      }
    }
  }
  if (packageVersion && released.length && released[0].version !== packageVersion) {
    errors.push(`package.json version ${packageVersion} differs from the latest release [${released[0].version}].`);
  }
  return errors;
}

export function promote(text, version, date, packageVersion) {
  assert(/^\d+\.\d+\.\d+$/.test(version), "Version must look like X.Y.Z");
  assert(/^\d{4}-\d{2}-\d{2}$/.test(date), "Date must look like YYYY-MM-DD");
  const errors = validateChangelog(text);
  assert(!errors.length, `CHANGELOG.md has errors:\n- ${errors.join("\n- ")}`);
  const sections = parseChangelog(text);
  const unreleased = sections[0];
  assert(entryCount(unreleased) > 0, "[Unreleased] has no entries to release.");
  const latest = sections.find((section) => section.version !== "Unreleased");
  if (latest) {
    assert(compare(version, latest.version) > 0, `Version must be higher than the latest release ${latest.version}.`);
    const [a, b] = [version, latest.version].map((v) => v.split(".").map(Number));
    assert(!(unreleased.groups.some((g) => g.name === "Added") && a[0] === b[0] && a[1] === b[1]),
      "[Unreleased] has Added entries, so raise at least the minor version.");
  }
  assert(packageVersion === undefined || !latest || packageVersion === latest.version, "package.json and the latest release differ.");
  return String(text).replace(/\r\n/g, "\n").replace(/^## \[Unreleased\][^\n]*$/m, `## [Unreleased]\n\n## [${version}] - ${date}`);
}

export function releaseNotes(text, version) {
  const sections = parseChangelog(text);
  const at = sections.findIndex((section) => section.version === version);
  assert(at !== -1 && sections[at].date, `[${version}] is not a released section.`);
  const body = sections[at].lines.join("\n").trim();
  const previous = sections.slice(at + 1).find((section) => section.version !== "Unreleased");
  const link = previous ? `${REPO_URL}/compare/v${previous.version}...v${version}` : `${REPO_URL}/releases/tag/v${version}`;
  return `${body}\n\n---\n\n**${previous ? "전체 변경" : "릴리스"}:** ${link}\n`;
}

// 화면의 '업데이트 내역'이 읽는 형태. 출시 전 항목은 비어 있지 않을 때만 맨 위에 둔다.
export function changelogForScreen(text) {
  return parseChangelog(text)
    .filter((section) => section.version !== "Unreleased" || entryCount(section) > 0)
    .map(({ version, date, groups }) => ({
      version, date,
      groups: groups.filter((g) => GROUPS[g.name]).map((g) => ({ name: g.name, label: GROUPS[g.name], entries: g.entries.map(({ title, body }) => ({ title, body })) })),
    }));
}

export const readChangelog = () => readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");

function main([command, version, ...rest]) {
  const path = join(ROOT, "CHANGELOG.md");
  const packagePath = join(ROOT, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const text = readFileSync(path, "utf8");
  if (command === "check") {
    const errors = validateChangelog(text, { packageVersion: packageJson.version });
    if (errors.length) throw new Error(["Release notes check failed:", ...errors.map((e) => `- ${e}`)].join("\n"));
    console.log("Release notes check passed.");
  } else if (command === "release") {
    const dateAt = rest.indexOf("--date");
    const date = dateAt === -1 ? new Date().toISOString().slice(0, 10) : rest[dateAt + 1];
    writeFileSync(path, promote(text, version, date, packageJson.version));
    writeFileSync(packagePath, `${JSON.stringify({ ...packageJson, version }, null, 2)}\n`);
    console.log(`Released ${version} (${date}). Review CHANGELOG.md and package.json, then commit.`);
  } else if (command === "notes") {
    process.stdout.write(releaseNotes(text, version));
  } else {
    throw new Error("Usage: node src/release-notes.js check | release <X.Y.Z> [--date YYYY-MM-DD] | notes <X.Y.Z>");
  }
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
