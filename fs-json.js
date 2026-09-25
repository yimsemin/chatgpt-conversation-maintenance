// JSON 파일 읽기·쓰기의 단일 구현. 모든 파일 쓰기는 임시 파일에 쓴 뒤 이름을 바꿔 원자적으로 반영한다.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { assert } from "./assert.js";

export function readJson(path, label = "JSON") {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`${label}을(를) 읽을 수 없습니다: ${path}`); }
}

// exclusive: 이미 있는 파일을 덮어쓰지 않는다(실행 산출물처럼 한 번만 써야 하는 파일).
export function writeJsonAtomic(path, value, { exclusive = false } = {}) {
  if (exclusive) assert(!existsSync(path), `Output already exists: ${path}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const partial = `${path}.partial-${randomUUID()}`;
  try {
    writeFileSync(partial, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (exclusive) assert(!existsSync(path), `Output already exists: ${path}`);
    renameSync(partial, path);
  } catch (error) {
    try { unlinkSync(partial); } catch {}
    throw error;
  }
}
