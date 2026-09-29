// 스캔: 고른 범위의 대화를 후보로 삼고 후보 본문을 받아 인벤토리를 만든다. ChatGPT는 읽기만 한다.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assert } from "./assert.js";
import { runFiles } from "./run-files.js";
import { writeJsonAtomic } from "./fs-json.js";
import { attachmentReferenceCount, contentSha256, sha256 } from "./content-hash.js";
import { runsDir } from "./data-dir.js";
import { collectConversationCatalog, collectScopedCatalog, timeMilliseconds } from "./catalog.js";

try { process.umask(0o077); } catch {}

// 수집 도중 끊긴 실행만 같은 폴더에서 이어받는다. 인벤토리까지 만든 실행은 다시 쓰지 않는다.
function prepareRunDirectory(path) {
  const root = resolve(path);
  mkdirSync(root, { recursive: true });
  assert(statSync(root).isDirectory(), `Run path is not a directory: ${root}`);
  assert(readdirSync(root).every((name) => name === "json" || name === "scan-draft.json"), `Run directory is not resumable: ${root}`);
  mkdirSync(join(root, "json"), { recursive: true });
  return root;
}

// 조사 범위. kind: "unassigned"(프로젝트 없는 대화) | "project"(projectName 프로젝트) | "recent"(최근 days일 안에 수정) |
// "untidy"(수정 최신순으로 읽다 표준 제목 대화가 3건 연달아 나오면 멈춤), "all"(모든 대화, 보관된 것 포함 — 전체 재정비용).
export const SCOPE_KINDS = ["unassigned", "project", "recent", "untidy", "all"];
const MAX_RECENT_DAYS = 3650;
const MAX_SCOPE_PROJECTS = 20;

export function validateScope(scope) {
  assert(scope && typeof scope === "object" && !Array.isArray(scope), "조사 범위가 올바르지 않습니다");
  assert(SCOPE_KINDS.includes(scope.kind), "조사 범위 종류가 올바르지 않습니다");
  if (scope.kind === "project") {
    // 프로젝트 여러 개를 고를 수 있다(projectNames). 하나만 적은 옛 형식(projectName)도 받는다.
    const names = Array.isArray(scope.projectNames) ? scope.projectNames : [scope.projectName];
    assert(names.length >= 1 && names.length <= MAX_SCOPE_PROJECTS, `프로젝트는 1~${MAX_SCOPE_PROJECTS}개를 고르세요`);
    for (const name of names) {
      assert(typeof name === "string" && name.trim() === name && name.length > 0 && name.length <= 100, "프로젝트 이름이 올바르지 않습니다");
    }
    return { kind: "project", projectNames: [...new Set(names)] };
  }
  const validDays = (days) => Number.isInteger(days) && days >= 1 && days <= MAX_RECENT_DAYS;
  if (scope.kind === "recent") {
    assert(validDays(scope.days), "최근 일수는 1 이상의 정수여야 합니다");
    return { kind: "recent", days: scope.days };
  }
  if (scope.kind === "unassigned") {
    // days 가 없으면 기간 제한 없이 프로젝트 없는 대화 전체다.
    assert(scope.days == null || validDays(scope.days), "기간(일)은 1 이상의 정수여야 합니다");
    return scope.days == null ? { kind: "unassigned" } : { kind: "unassigned", days: scope.days };
  }
  return { kind: scope.kind };
}

export function describeScope(scope) {
  if (scope.kind === "project") return `프로젝트 ${scope.projectNames.map((name) => `「${name}」`).join(", ")}`;
  if (scope.kind === "recent") return `최근 ${scope.days}일 안에 수정된 대화`;
  if (scope.kind === "untidy") return "아직 정돈되지 않은 대화(표준 제목 3건 연속 전까지)";
  if (scope.kind === "all") return "모든 대화";
  return scope.days ? `프로젝트에 넣지 않은 대화(최근 ${scope.days}일)` : "프로젝트에 넣지 않은 대화(전체 기간)";
}

function conversationRecord(catalogItem, data, raw, backupFile) {
  const id = data?.conversation_id || data?.id;
  assert(id === catalogItem.conversationId, `Conversation download returned a different ID: ${catalogItem.conversationId}`);
  assert(data?.title === catalogItem.title, `Conversation title changed during scan: ${catalogItem.conversationId}`);
  assert(data?.mapping && typeof data.mapping === "object" && Object.keys(data.mapping).length > 0,
    `Conversation has no mapping: ${catalogItem.conversationId}`);
  return {
    ...catalogItem,
    messageCount: Object.values(data.mapping).filter((node) => node?.message).length,
    attachmentReferenceCount: attachmentReferenceCount(data),
    contentSha256: contentSha256(data),
    backupFile,
    backupBytes: raw.length,
    backupSha256: sha256(raw),
  };
}

// resume 이면 이미 받은 본문이 이 대화와 맞고 그 뒤 수정되지 않았을 때 다시 받지 않고 재사용한다.
// 맞지 않거나 깨졌거나 그 뒤 수정된 파일은 새로 받아 덮어쓴다.
const RESUME_TIME_TOLERANCE_MS = 2000;
// 받지 못하는 대화 건너뛰기: 이 횟수만큼 시도해도 응답이 실패로 오면 그 대화만 건너뛴다(첫 시도 포함).
export const SKIP_AFTER_FAILURES = 4;

// skipFailed 이면 SKIP_AFTER_FAILURES 번 시도해 실패하는 대화는 null 을 돌려주고(호출 쪽이 건너뜀), 아니면 실패로 중단한다.
async function downloadConversation(api, catalogItem, jsonDirectory, { resume = false, skipFailed = false, onSkip = () => {} } = {}) {
  const backupFile = resolve(jsonDirectory, `${catalogItem.conversationId}.json`);
  if (resume && existsSync(backupFile)) {
    try {
      const raw = readFileSync(backupFile);
      const data = JSON.parse(raw.toString("utf8"));
      // 받아 둔 뒤 대화가 수정됐으면(목록의 수정 시각이 본문보다 새로우면) 예전 본문이므로 다시 받는다.
      // 같은 시각도 엔드포인트마다 0.1~0.3초 어긋나므로 허용 오차를 둔다.
      const stored = timeMilliseconds(data?.update_time);
      const listed = timeMilliseconds(catalogItem.updateTime);
      if (stored === null || listed === null || Math.abs(stored - listed) <= RESUME_TIME_TOLERANCE_MS) {
        return conversationRecord(catalogItem, data, raw, backupFile);
      }
    } catch {}
  }
  const response = await api.getConversation(catalogItem.conversationId, skipFailed ? { tries: SKIP_AFTER_FAILURES } : {});
  if (!response.ok && skipFailed) { onSkip({ conversationId: catalogItem.conversationId, title: catalogItem.title, status: response.status ?? null }); return null; }
  assert(response.ok, `Conversation download failed for ${catalogItem.conversationId}: HTTP ${response.status}`
    + (response.bodySnippet ? ` (${String(response.bodySnippet).slice(0, 120)})` : ""));
  const data = response.data;
  const raw = Buffer.from(JSON.stringify(data, null, 2));
  const record = conversationRecord(catalogItem, data, raw, backupFile);
  writeFileSync(backupFile, raw, { mode: 0o600, flag: resume ? "w" : "wx" });
  return record;
}

function maintenanceInventory({ runRoot, catalogPath, catalog, conversations, scope, partial = null, skipped = [] }) {
  return {
    version: 1,
    kind: "conversation-maintenance-inventory",
    generatedAt: catalog.generatedAt,
    runRoot,
    catalogFile: catalogPath,
    source: { mode: "scope", scope },
    counts: {
      catalogConversations: catalog.conversations.length,
      candidates: conversations.length,
      attachmentReferences: conversations.reduce((sum, item) => sum + item.attachmentReferenceCount, 0),
    },
    warnings: [],
    ...(partial ? { partial } : {}),
    ...(skipped.length ? { skipped } : {}),
    projects: catalog.projects,
    conversations: conversations.sort((left, right) => left.conversationId.localeCompare(right.conversationId)),
  };
}

// 범위 안의 대화를 모두 후보로 받는다(지난 확인과 비교하지 않는다). 도중에 끊긴 실행 폴더는 같은 runDir 로 이어받는다.
// 프로젝트·기록 파일은 만들지 않고 실행 폴더(runDir)에만 결과를 남긴다.
export async function scanMaintenanceRun({ runDir, api, scope, skipFailed = false, knownProjects = [], now = () => new Date(), onProgress = () => {}, onSkip = () => {} }) {
  const validScope = validateScope(scope);
  const root = prepareRunDirectory(runDir);
  const catalog = validScope.kind === "all"
    ? await collectConversationCatalog(api, now, onProgress)
    : await collectScopedCatalog(api, validScope, now, onProgress, { knownProjects });
  // 본문은 수정 시각 최신순으로 받는다(끊겨도 최근 대화가 먼저 남는다).
  const selected = catalog.conversations
    .filter((item) => validScope.kind === "all" || !item.isArchived)
    .sort((left, right) => (timeMilliseconds(right.updateTime) ?? 0) - (timeMilliseconds(left.updateTime) ?? 0)
      || left.conversationId.localeCompare(right.conversationId))
    .map((item) => ({ ...item, reasons: ["scope"] }));
  writeJsonAtomic(runFiles(root).scanDraft, { version: 1, kind: "scan-draft", scope: validScope, catalog, selected });
  const candidates = [];
  const skipped = [];
  for (const [index, candidate] of selected.entries()) {
    onProgress({ phase: "downloads", index, total: selected.length });
    const record = await downloadConversation(api, candidate, join(root, "json"), { resume: true, skipFailed, onSkip: (item) => { skipped.push(item); onSkip(item); } });
    if (record) candidates.push({ ...record, reasons: candidate.reasons });
  }
  onProgress({ phase: "downloads", index: selected.length, total: selected.length });
  return publishInventory({ root, catalog, candidates, scope: validScope, skipped });
}

function publishInventory({ root, catalog, candidates, scope, partial = null, skipped = [] }) {
  const catalogPath = runFiles(root).catalog;
  writeJsonAtomic(catalogPath, catalog, { exclusive: true });
  const inventory = maintenanceInventory({ runRoot: root, catalogPath, catalog, conversations: candidates, scope, partial, skipped });
  const inventoryPath = runFiles(root).inventory;
  writeJsonAtomic(inventoryPath, inventory, { exclusive: true });
  return { root, inventoryPath, catalog, inventory };
}

// 끊긴 확인에서 지금까지 받은 본문만으로 인벤토리를 만든다(받지 못한 대화는 후보에서 뺀다). ChatGPT는 읽지 않는다.
// scan-draft.json 은 대화 목록을 다 읽은 뒤 본문을 받기 시작할 때 남긴다. 인벤토리를 만들면 그 폴더는 더 이어받지 않는다.
export function readScanDraft(runDir) {
  const path = runFiles(runDir).scanDraft;
  if (!existsSync(path) || existsSync(runFiles(runDir).inventory)) return null;
  try {
    const draft = JSON.parse(readFileSync(path, "utf8"));
    return draft?.kind === "scan-draft" && Array.isArray(draft.selected) ? draft : null;
  } catch { return null; }
}

export function countDownloaded(runDir, draft) {
  return draft.selected.filter((item) => existsSync(join(runFiles(runDir).jsonDir, `${item.conversationId}.json`))).length;
}

// 가장 최근에 끊긴(대화 목록은 읽었고 인벤토리는 없는) 확인. 받아 둔 본문이 있을 때만 돌려준다.
export function findPartialScan(dataDir) {
  const root = runsDir(dataDir);
  if (!existsSync(root)) return null;
  let best = null;
  for (const name of readdirSync(root)) {
    if (!name.startsWith("scan-") && !name.startsWith("overhaul-")) continue;
    const runDir = join(root, name);
    const draft = readScanDraft(runDir);
    if (!draft) continue;
    const downloaded = countDownloaded(runDir, draft);
    if (downloaded === 0) continue;
    const modified = statSync(runFiles(runDir).scanDraft).mtimeMs;
    if (!best || modified > best.modified) best = { runDir, scope: draft.scope, downloaded, total: draft.selected.length, modified };
  }
  return best && { runDir: best.runDir, scope: best.scope, downloaded: best.downloaded, total: best.total };
}

export function finishPartialScan({ runDir }) {
  const root = resolve(runDir);
  const draft = readScanDraft(root);
  assert(draft, "이어서 쓸 수 있는 끊긴 확인이 없습니다");
  const candidates = [];
  for (const item of draft.selected) {
    const backupFile = resolve(root, "json", `${item.conversationId}.json`);
    if (!existsSync(backupFile)) continue;
    try {
      const raw = readFileSync(backupFile);
      candidates.push({ ...conversationRecord(item, JSON.parse(raw.toString("utf8")), raw, backupFile), reasons: item.reasons });
    } catch {}
  }
  assert(candidates.length > 0, "받아 둔 대화 본문이 없습니다");
  return publishInventory({ root, catalog: draft.catalog, candidates, scope: draft.scope,
    partial: { downloaded: candidates.length, total: draft.selected.length } });
}
