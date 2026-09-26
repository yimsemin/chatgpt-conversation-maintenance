// 알려진 프로젝트 이름 목록(범위 선택용). 스캔·프로젝트 목록 읽기가 끝날 때 갱신하는 읽기용 사본이며 판단의 근거가 아니다.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const FILE = "known-projects.json";

export function readKnownProjects(dataDir) {
  try {
    const data = JSON.parse(readFileSync(join(dataDir, FILE), "utf8"));
    if (data?.version === 1 && Array.isArray(data.names)) return { updatedAt: data.updatedAt || null, names: data.names.filter((name) => typeof name === "string") };
  } catch {}
  return { updatedAt: null, names: [] };
}

export function writeKnownProjects(dataDir, names, now = () => new Date()) {
  const path = join(dataDir, FILE);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const partial = `${path}.partial-${randomUUID()}`;
  const value = { version: 1, updatedAt: now().toISOString(), names: [...new Set(names)].sort((a, b) => a.localeCompare(b)) };
  writeFileSync(partial, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(partial, path);
  return value;
}
