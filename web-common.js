// 유지관리 웹앱 공용: 파일 읽기·쓰기, 작업 폴더 검증, 현재 실행 포인터, 안전한 오류 진단.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assert } from "./assert.js";
import { runFiles } from "./run-files.js";
import { readJson, writeJsonAtomic } from "./fs-json.js";
import { resolveDataDir, runsDir, stateFilePath } from "./data-dir.js";
import { explainError } from "./errors.js";

export const APP_ROOT = dirname(fileURLToPath(import.meta.url));

export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function jsonResponse(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

export async function readRequestJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    assert(size <= MAX_BODY_BYTES, "요청 본문이 너무 큽니다");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("요청 본문이 올바른 JSON이 아닙니다"); }
}

function isInside(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

export function validateMaintenanceWorkspace(value, { requireState = true } = {}) {
  assert(typeof value === "string" && value.trim(), "작업 폴더를 선택하세요");
  const workspace = resolve(value.trim());
  const packagePath = join(workspace, "package.json");
  assert(existsSync(packagePath), "선택한 폴더에 package.json이 없습니다");
  const pkg = readJson(packagePath, "package.json");
  assert(pkg.name === "chatgpt-conversation-maintenance", "대화 유지관리 프로젝트 폴더가 아닙니다");
  const dataDir = resolveDataDir({ appRoot: workspace });
  const statePath = stateFilePath(dataDir);
  if (!requireState && !existsSync(statePath)) return { workspace, dataDir, statePath, state: null };
  assert(existsSync(statePath), `데이터 폴더에 state.json이 없습니다: ${statePath}`);
  const state = readJson(statePath, "기준선");
  assert(state.kind === "conversation-maintenance-state", "state.json 형식이 올바르지 않습니다");
  return { workspace, dataDir, statePath, state };
}

export function pointerPath(workspace) {
  return join(workspace, ".local", "maintenance-web.json");
}

export function readPointer(workspace, dataDir) {
  const path = pointerPath(workspace);
  if (!existsSync(path)) return null;
  const pointer = readJson(path, "로컬 실행 상태");
  if (pointer?.version !== 1 || typeof pointer.runDir !== "string") return null;
  if (!isInside(runsDir(dataDir), pointer.runDir)) return null;
  return pointer;
}

export function writePointer(workspace, value) {
  writeJsonAtomic(pointerPath(workspace), {
    version: 1,
    updatedAt: new Date().toISOString(),
    ...value,
  });
}

export function publicPointer(pointer) {
  return {
    phase: pointer.phase,
    runId: basename(pointer.runDir),
    runDir: pointer.runDir,
    inventoryPath: pointer.inventoryPath,
    reviewPath: pointer.reviewPath || null,
    proposalPath: pointer.proposalPath || runFiles(pointer.runDir).proposal,
    updatedAt: pointer.updatedAt,
    result: pointer.result || null,
  };
}

function safeText(value, workspace = "") {
  let text = String(value || "알 수 없는 오류");
  if (workspace) text = text.split(resolve(workspace)).join("<workspace>");
  text = text
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer <redacted>")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<redacted-token>")
    .replace(/"accessToken"\s*:\s*"[^"]+"/gi, '"accessToken":"<redacted>"');
  return text.slice(0, 3000);
}

function errorCode(message) {
  const value = String(message).toLowerCase();
  if (value.includes("session") || value.includes("accesstoken") || value.includes("http 401")) return "AUTH_INVALID";
  if (value.includes("lock")) return "LOCK_UNAVAILABLE";
  if (value.includes("inventory digest") || value.includes("do not match the inventory")) return "STALE_PROPOSAL";
  if (value.includes("undecided")) return "PROPOSAL_UNDECIDED";
  if (value.includes("manual-move")) return "MANUAL_MOVE_REQUIRED";
  if (value.includes("http 429")) return "RATE_LIMITED";
  return "WORKFLOW_FAILED";
}

export function createSafeDiagnostic(stage, error, workspace, runId = null) {
  const message = safeText(error?.message || error, workspace);
  return {
    stage,
    code: errorCode(message),
    runId,
    occurredAt: new Date().toISOString(),
    message,
    explain: explainError(message),
  };
}

export function runId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const device = hostname().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "device";
  return `${stamp}-${device}-${randomUUID().slice(0, 6)}`;
}
