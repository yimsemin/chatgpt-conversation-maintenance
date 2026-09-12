import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDataDir, runsDir, stateFilePath } from "./data-dir.js";
import { acquireLock, lockStatus, releaseLock } from "./maintenance-lock.js";
import { createRelayApi } from "./relay-api.js";
import { relayBroker } from "./remote-relay.js";
import { applyPlanSet, preparePlanSet } from "./management-cli.js";
import {
  checkpointMaintenanceRun,
  scanMaintenanceRun,
  synchronizeMaintenanceStateAfterProjectRouting,
} from "./maintenance-cli.js";
import { prepareProjectRouting, projectRoutingStatus, runProjectRouting, validateProjectRouting } from "./project-routing.js";
import {
  buildClaudePrompt,
  CLASSIFICATION_CRITERIA,
  compileProjectRouting,
  compileReviewedDecisions,
  validateClassificationProposals,
  writeClassificationReview,
} from "./workflow.js";

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const APP_ROOT = dirname(fileURLToPath(import.meta.url));
const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const jobs = new Map();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

// 표준 제목 형식 "주제 — 작업/결과". 규칙의 정본은 CLASSIFICATION_WORKFLOW.md이며
// workflow.js·maintenance-cli.js도 같은 검사를 각자 둔다.
function isNormalizedTitle(title) {
  if (typeof title !== "string" || title !== title.trim()) return false;
  const parts = title.split(" — ");
  return parts.length === 2
    && parts.every((part) => part.length > 0 && part === part.trim() && !part.includes("—"));
}

function readJson(path, label = "JSON") {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`${label}을 읽을 수 없습니다: ${path}`); }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const partial = `${path}.partial-${randomUUID()}`;
  writeFileSync(partial, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(partial, path);
}

function jsonResponse(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

async function readRequestJson(req) {
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

export function validateMaintenanceWorkspace(value) {
  assert(typeof value === "string" && value.trim(), "작업 폴더를 선택하세요");
  const workspace = resolve(value.trim());
  const packagePath = join(workspace, "package.json");
  assert(existsSync(packagePath), "선택한 폴더에 package.json이 없습니다");
  const pkg = readJson(packagePath, "package.json");
  assert(pkg.name === "chatgpt-conversation-maintenance", "대화 유지관리 프로젝트 폴더가 아닙니다");
  const dataDir = resolveDataDir({ appRoot: workspace });
  const statePath = stateFilePath(dataDir);
  assert(existsSync(statePath), `데이터 폴더에 state.json이 없습니다: ${statePath}`);
  const state = readJson(statePath, "기준선");
  assert(state.kind === "conversation-maintenance-state", "state.json 형식이 올바르지 않습니다");
  return { workspace, dataDir, statePath, state };
}

function pointerPath(workspace) {
  return join(workspace, ".local", "maintenance-web.json");
}

function readPointer(workspace, dataDir) {
  const path = pointerPath(workspace);
  if (!existsSync(path)) return null;
  const pointer = readJson(path, "로컬 실행 상태");
  if (pointer?.version !== 1 || typeof pointer.runDir !== "string") return null;
  if (!isInside(runsDir(dataDir), pointer.runDir)) return null;
  return pointer;
}

function writePointer(workspace, value) {
  writeJsonAtomic(pointerPath(workspace), {
    version: 1,
    updatedAt: new Date().toISOString(),
    ...value,
  });
}

function workspaceStatus(workspaceValue) {
  const { workspace, dataDir, state } = validateMaintenanceWorkspace(workspaceValue);
  const lock = lockStatus({ dataDir });
  const pointer = readPointer(workspace, dataDir);
  return {
    ok: true,
    workspace,
    dataDir,
    lock: lock.locked
      ? { device: lock.holder?.device || null, acquiredAt: lock.holder?.acquiredAt || null, stale: lock.stale }
      : null,
    baseline: {
      generatedAt: state.generatedAt || null,
      counts: state.counts || {},
    },
    currentRun: pointer ? publicPointer(pointer) : null,
  };
}

function publicPointer(pointer) {
  return {
    phase: pointer.phase,
    runId: basename(pointer.runDir),
    runDir: pointer.runDir,
    inventoryPath: pointer.inventoryPath,
    reviewPath: pointer.reviewPath || null,
    proposalPath: pointer.proposalPath || join(pointer.runDir, "proposal.json"),
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
  };
}

function cleanupJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) if (job.createdAt < cutoff) jobs.delete(id);
}

function createJob(kind, workspace) {
  cleanupJobs();
  assert(![...jobs.values()].some((job) => !job.done && job.workspace === workspace),
    "이 작업 폴더에서 이미 다른 작업이 진행 중입니다");
  const id = randomUUID();
  const job = { id, kind, workspace, createdAt: Date.now(), events: [], done: false, ok: null, result: null, error: null };
  jobs.set(id, job);
  return job;
}

function jobEvent(job, stage, message) {
  job.events.push({ at: new Date().toISOString(), stage, message });
}

function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    done: job.done,
    ok: job.ok,
    events: job.events,
    result: job.result,
    error: job.error,
  };
}

function runId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const device = hostname().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "device";
  return `${stamp}-${device}-${randomUUID().slice(0, 6)}`;
}

function relayApi(job, requestDelayMs = 1000) {
  return createRelayApi({ broker: relayBroker, requestDelayMs, onRetry: (retry) => {
    const status = retry.status ? ` HTTP ${retry.status}` : "";
    const stage = retry.type === "http" && retry.status === 429 ? "rate-limit" : "retry";
    jobEvent(job, stage, `Retry${status} in ${Math.round(retry.waitMs / 1000)}s (${retry.attempt})`);
  } });
}

async function relayAccountId(api) {
  const response = await api.accountInfo();
  assert(response.ok, `ChatGPT account lookup failed: HTTP ${response.status}`);
  const accountId = response.data?.accountId || "";
  assert(ACCOUNT_ID.test(accountId), "ChatGPT relay returned an invalid account ID");
  return accountId;
}

async function scanWorkflow(workspace, dataDir, api, job) {
  let lockHeld = false;
  try {
    jobEvent(job, "lock", "로컬 유지관리 잠금을 획득합니다.");
    acquireLock({ dataDir });
    lockHeld = true;
    const id = runId();
    const runDir = join(runsDir(dataDir), id);
    const inventoryPath = join(runDir, "inventory.json");
    const reviewPath = join(runDir, "review.json");
    jobEvent(job, "scan", "ChatGPT의 새 대화와 변경 대화를 확인합니다.");
    const scanResult = await scanMaintenanceRun({ statePath: stateFilePath(dataDir), runDir, api, dataDir });
    const scan = { counts: scanResult.inventory.counts, warnings: scanResult.inventory.warnings };
    const candidateCount = Number(scan.counts?.candidates || 0);
    const heldCount = Number(scan.counts?.held || 0);
    if (heldCount > 0) {
      jobEvent(job, "hold", `${heldCount}개는 형식만 어긋난 보류 항목이라 이번 재분류에서 제외했습니다.`);
    }
    const pointer = {
      phase: candidateCount > 0 ? "awaiting-proposal" : "complete",
      runDir,
      inventoryPath,
      reviewPath: candidateCount > 0 ? reviewPath : null,
      proposalPath: join(runDir, "proposal.json"),
      result: { counts: scan.counts, warnings: scan.warnings || [] },
    };
    if (candidateCount > 0) {
      jobEvent(job, "review", "AI가 읽을 최소 분류 입력을 만듭니다.");
      writeClassificationReview(inventoryPath, reviewPath);
      writePointer(workspace, pointer);
      job.result = { phase: "awaiting-proposal", run: publicPointer({ ...pointer, updatedAt: new Date().toISOString() }) };
      jobEvent(job, "ready", `${candidateCount}개 후보의 분류 요청 준비가 끝났습니다.`);
      return;
    }
    writePointer(workspace, pointer);
    jobEvent(job, "complete", "분류할 후보가 없어 기준선을 갱신했습니다.");
    job.result = { phase: "complete", run: publicPointer({ ...pointer, updatedAt: new Date().toISOString() }) };
  } finally {
    if (lockHeld) releaseLock({ dataDir });
  }
}

function proposalData(workspace, dataDir) {
  const pointer = readPointer(workspace, dataDir);
  if (!pointer) return { ready: false, run: null };
  const proposalPath = pointer.proposalPath || join(pointer.runDir, "proposal.json");
  if (!existsSync(proposalPath)) {
    return {
      ready: false,
      run: publicPointer(pointer),
      prompt: classificationPrompt(pointer),
      claudePrompt: claudePrompt(pointer),
    };
  }
  const validation = validateClassificationProposals(pointer.inventoryPath, proposalPath);
  const proposal = readJson(proposalPath, "분류안");
  const manualMoves = proposal.items.filter((item) => item.suggestedProjectAction === "manual-move").length;
  return {
    ready: true,
    run: publicPointer(pointer),
    validation,
    items: proposal.items,
    prompt: classificationPrompt(pointer),
    claudePrompt: claudePrompt(pointer),
    blockers: {
      undecided: validation.decisionCounts.undecided,
      manualMoves,
    },
  };
}

// 파일 접근이 가능한 에이전트(같은 저장소의 Codex/Claude Code)용. 규칙 문서를
// 통째로 읽게 하지 않고 압축 기준을 프롬프트에 바로 넣는다.
function classificationPrompt(pointer) {
  const proposalPath = pointer.proposalPath || join(pointer.runDir, "proposal.json");
  return [
    "이 작업공간에서 ChatGPT 대화 유지관리의 '분류' 단계를 수행해줘. 분류만 하고 승인 파일·실행 계획·원격 변경은 만들거나 실행하지 마.",
    "판단 기준은 아래에 모두 있으니 저장소 문서를 따로 읽지 않아도 돼.",
    "",
    `인벤토리: ${pointer.inventoryPath}`,
    `분류용 최소 입력(발췌): ${pointer.reviewPath}`,
    `결과 파일: ${proposalPath}`,
    "",
    "## 판단 기준",
    ...CLASSIFICATION_CRITERIA.map((line) => `- ${line}`),
    "",
    "review.json의 후보 전체만 분류하고, 첨부·비텍스트 때문에 불분명한 항목만 원본 JSON을 추가 확인해.",
    "모든 후보에 보존·삭제·미결정, 표준 제목(null 가능), 최종 프로젝트, 프로젝트 조치, 확신도, 근거를 제안해 proposal.json으로 저장해.",
    `저장 후 node workflow.js validate-proposal "${pointer.inventoryPath}" "${proposalPath}" 로 검증하고, 결과 JSON 전문을 답변에도 붙여줘 — 유지관리 앱의 '분류 결과 JSON 붙여넣기' 칸에 넣을 수 있게.`,
  ].join("\n");
}

// claude.ai 등 파일 접근이 없는 곳에 그대로 붙여넣을 자립형 요청문.
function claudePrompt(pointer) {
  if (!pointer.reviewPath || !existsSync(pointer.reviewPath)) return null;
  try {
    return buildClaudePrompt(readJson(pointer.reviewPath, "분류용 입력"), {
      inventoryPath: pointer.inventoryPath,
      proposalPath: pointer.proposalPath || join(pointer.runDir, "proposal.json"),
    });
  } catch { return null; }
}

// 스캔 후에는 이번 실행의 catalog.json, 스캔 전에는 데이터 폴더의 기준선(state.json)에서
// 대화 전체 목록을 만든다. 화면의 검색·필터·정렬은 클라이언트가 처리한다.
function catalogData(workspace, dataDir) {
  const pointer = readPointer(workspace, dataDir);
  const runCatalogPath = pointer ? join(pointer.runDir, "catalog.json") : null;
  const useRun = Boolean(runCatalogPath && existsSync(runCatalogPath));
  const catalog = useRun
    ? readJson(runCatalogPath, "카탈로그")
    : readJson(stateFilePath(dataDir), "기준선");

  const reasonsById = new Map();
  let heldConversationIds = [];
  if (useRun && existsSync(pointer.inventoryPath)) {
    const inventory = readJson(pointer.inventoryPath, "인벤토리");
    for (const item of inventory.conversations || []) {
      reasonsById.set(item.conversationId, item.reasons || []);
    }
    heldConversationIds = inventory.heldConversationIds || [];
  }

  const conversations = (catalog.conversations || []).map((item) => ({
    conversationId: item.conversationId,
    title: item.title,
    projectName: item.projectName || null,
    createTime: item.createTime ?? null,
    updateTime: item.updateTime ?? null,
    isArchived: item.isArchived === true,
    reasons: reasonsById.get(item.conversationId) || [],
  }));

  return {
    source: useRun ? "scan" : "baseline",
    generatedAt: catalog.generatedAt || null,
    counts: {
      conversations: conversations.length,
      unassigned: conversations.filter((item) => !item.projectName).length,
      archived: conversations.filter((item) => item.isArchived).length,
      candidates: reasonsById.size,
      held: heldConversationIds.length,
      projects: (catalog.projects || []).length,
    },
    projects: (catalog.projects || []).map((project) => ({
      projectName: project.projectName,
      conversationCount: project.conversationCount ?? null,
    })),
    currentRun: pointer ? publicPointer(pointer) : null,
    conversations,
  };
}

// 화면에서 직접 만든 후보별 결정을 reviewed-decisions.json 형식으로 검증·변환한다.
// 규칙은 workflow.js compileReviewedDecisions / maintenance-cli.js checkpointMaintenanceRun과 같다.
export function buildReviewedDecisionsFromInputs(pointer, inventory, inputs) {
  assert(inventory?.version === 1 && inventory.kind === "conversation-maintenance-inventory",
    "유지관리 인벤토리가 아닙니다");
  assert(Array.isArray(inventory.warnings) && inventory.warnings.length === 0,
    `인벤토리에 경고가 있어 결정을 만들 수 없습니다: ${(inventory.warnings || ["warnings 필드 없음"]).join("; ")}`);
  assert(Array.isArray(inputs) && inputs.length > 0, "결정이 비어 있습니다");
  const inventoryById = new Map(inventory.conversations.map((item) => [item.conversationId, item]));
  const seen = new Set();
  const decisions = inputs.map((input, index) => {
    const label = `결정[${index}]`;
    assert(input && typeof input === "object" && !Array.isArray(input), `${label} 형식이 올바르지 않습니다`);
    const source = inventoryById.get(input.conversationId);
    assert(source, `${label}: 인벤토리에 없는 대화입니다`);
    assert(!seen.has(input.conversationId), `${label}: 중복된 대화입니다`);
    seen.add(input.conversationId);
    assert(input.decision === "keep" || input.decision === "delete",
      `${label}: 결정은 보존 또는 삭제여야 합니다`);
    const newTitle = typeof input.newTitle === "string" ? input.newTitle.trim() : "";
    if (input.decision === "delete") {
      assert(!newTitle, `${label}: 삭제할 대화의 제목은 바꿀 수 없습니다`);
      return { conversationId: source.conversationId, decision: "delete", reviewed: true };
    }
    assert(isNormalizedTitle(newTitle || source.title),
      `${label}: 제목은 "주제 — 작업/결과" 형식이어야 합니다`);
    const projectName = typeof input.projectName === "string" ? input.projectName.trim() : "";
    assert(projectName, `${label}: 보존 대화에는 프로젝트가 필요합니다`);
    if (source.projectName) {
      assert(projectName === source.projectName,
        `${label}: 이미 프로젝트에 있는 대화는 화면에서 옮길 수 없습니다 (ChatGPT에서 직접 옮긴 뒤 다시 스캔)`);
    }
    return {
      conversationId: source.conversationId,
      decision: "keep",
      ...(newTitle && newTitle !== source.title ? { newTitle } : {}),
      projectName,
      reviewed: true,
    };
  });
  assert(seen.size === inventoryById.size, "모든 후보에 정확히 하나의 결정이 필요합니다");
  return {
    version: 1,
    kind: "reviewed-decisions",
    inventoryDigest: sha256(readFileSync(pointer.inventoryPath)),
    receiptDir: join(pointer.runDir, "receipts"),
    decisions,
  };
}

function reviewedDecisionsSummary(inventory, decisions) {
  const existingProjects = new Set((inventory.projects || []).map((project) => project.projectName));
  const newProjectNames = new Set();
  const counts = { keep: 0, delete: 0, rename: 0 };
  for (const decision of decisions.decisions) {
    counts[decision.decision]++;
    if (decision.newTitle) counts.rename++;
    if (decision.decision === "keep" && decision.projectName && !existingProjects.has(decision.projectName)) {
      newProjectNames.add(decision.projectName);
    }
  }
  return {
    candidateCount: inventory.conversations.length,
    decidedCount: decisions.decisions.length,
    counts,
    newProjectNames: [...newProjectNames].sort(),
  };
}

function reviewedDecisionsData(workspace, dataDir) {
  const pointer = readPointer(workspace, dataDir);
  if (!pointer) return { ready: false, run: null };
  const decisionsPath = join(pointer.runDir, "reviewed-decisions.json");
  if (!existsSync(decisionsPath)) return { ready: false, run: publicPointer(pointer) };
  const inventory = readJson(pointer.inventoryPath, "인벤토리");
  const decisions = readJson(decisionsPath, "검토된 결정");
  return {
    ready: true,
    run: publicPointer(pointer),
    ...reviewedDecisionsSummary(inventory, decisions),
    decisions: decisions.decisions,
  };
}

function writeReviewedDecisions(workspace, dataDir, inputs) {
  const pointer = readPointer(workspace, dataDir);
  assert(pointer, "먼저 새 대화 확인을 실행하세요");
  assert(pointer.phase === "awaiting-proposal", "지금은 결정을 받을 단계가 아닙니다");
  const inventory = readJson(pointer.inventoryPath, "인벤토리");
  const decisions = buildReviewedDecisionsFromInputs(pointer, inventory, inputs);
  writeJsonAtomic(join(pointer.runDir, "reviewed-decisions.json"), decisions);
  return {
    ready: true,
    run: publicPointer(pointer),
    ...reviewedDecisionsSummary(inventory, decisions),
    decisions: decisions.decisions,
  };
}

function savePastedProposal(workspace, dataDir, proposalJson) {
  const pointer = readPointer(workspace, dataDir);
  assert(pointer, "먼저 새 대화 확인을 실행하세요");
  assert(pointer.phase === "awaiting-proposal", "지금은 분류안을 받을 단계가 아닙니다");
  assert(pointer.reviewPath, "이 실행에는 분류할 후보가 없습니다");
  let parsed;
  try { parsed = JSON.parse(typeof proposalJson === "string" ? proposalJson : ""); }
  catch { throw new Error("붙여넣은 분류안이 올바른 JSON이 아닙니다"); }
  assert(parsed && typeof parsed === "object" && !Array.isArray(parsed),
    "붙여넣은 분류안 형식이 올바르지 않습니다");
  const proposalPath = pointer.proposalPath || join(pointer.runDir, "proposal.json");
  writeJsonAtomic(proposalPath, parsed);
  return proposalData(workspace, dataDir);
}

export function buildReviewedDecisions(pointer, proposal) {
  return {
    version: 1,
    kind: "reviewed-decisions",
    inventoryDigest: proposal.inventoryDigest,
    receiptDir: join(pointer.runDir, "receipts"),
    decisions: proposal.items.map((item) => {
      assert(item.suggestedDecision !== "undecided", "undecided 항목은 승인 전에 해결해야 합니다");
      assert(item.suggestedProjectAction !== "manual-move", "manual-move 항목은 ChatGPT에서 직접 옮긴 뒤 다시 스캔해야 합니다");
      if (item.suggestedDecision === "delete") {
        return {
          conversationId: item.conversationId,
          decision: "delete",
          reviewed: true,
          rationale: item.rationale,
        };
      }
      return {
        conversationId: item.conversationId,
        decision: "keep",
        ...(item.suggestedNewTitle ? { newTitle: item.suggestedNewTitle } : {}),
        projectName: item.suggestedProjectName,
        reviewed: true,
        rationale: item.rationale,
      };
    }),
  };
}

const PLAN_SOURCE_FILE = "compiled-plan-source.json";

const PLAN_HALT_MESSAGES = {
  "changed-after-apply": "이미 적용한 결과(영수증)가 있는데 결정이 바뀌었습니다. "
    + "이 실행의 계획은 안전하게 다시 만들 수 없으므로 여기서 멈춥니다. "
    + "‘새 대화 확인’으로 현재 ChatGPT 상태를 다시 스캔한 뒤 새 실행에서 결정하세요.",
  "unknown-source-after-apply": "이 실행의 계획이 어떤 결정에서 나왔는지 확인할 수 없고 적용 결과(영수증)도 있습니다. "
    + "안전을 위해 멈춥니다. ‘새 대화 확인’으로 다시 스캔한 뒤 새 실행에서 결정하세요.",
};

// 이미 컴파일된 plans/·routing.json 을 지금의 승인(reviewed-decisions.json)에 그대로 써도 되는지 판정한다.
// 결정이 바뀐 뒤 옛 계획을 재사용하면 보존으로 바꾼 대화가 삭제될 수 있고,
// 이미 원격에 적용한 결과가 있으면 계획을 다시 만드는 것도 안전하지 않다.
export function planReuseDecision({ hasCompiledArtifacts, stampDigest, decisionsDigest, hasReceipts }) {
  if (!hasCompiledArtifacts) return { action: "compile", reason: "none" };
  if (stampDigest && stampDigest === decisionsDigest) return { action: "reuse", reason: "match" };
  const reason = stampDigest ? "changed" : "unknown-source";
  if (hasReceipts) return { action: "halt", reason: `${reason}-after-apply` };
  return { action: "recompile", reason };
}

// 이미 적용을 마친 실행은 다시 적용하지 않는다. 적용에 실패하면 phase 는 awaiting-proposal
// 로 남으므로 정상적인 재시도는 그대로 통과한다.
export function assertApplyablePhase(phase) {
  assert(phase !== "complete",
    "이 실행은 이미 적용을 마쳤습니다. 새 변경은 ‘새 대화 확인’으로 다시 스캔한 뒤 결정하세요.");
  return true;
}

function receiptFileCount(receiptDir) {
  if (!existsSync(receiptDir)) return 0;
  return readdirSync(receiptDir).filter((name) => name.toLowerCase().endsWith(".json")).length;
}

async function applyWorkflow(workspace, dataDir, api, accountId, confirmDeletes, job) {
  const pointer = readPointer(workspace, dataDir);
  assert(pointer, "적용할 현재 실행이 없습니다");
  assertApplyablePhase(pointer.phase);
  const decisionsPath = join(pointer.runDir, "reviewed-decisions.json");

  // 화면에서 저장한 결정이 있으면 그것을 그대로 쓰고, 없으면 붙여넣은 proposal.json에서 만든다.
  let deletes;
  let proposalCount;
  if (existsSync(decisionsPath)) {
    const reviewed = readJson(decisionsPath, "검토된 결정");
    assert(reviewed?.version === 1 && reviewed.kind === "reviewed-decisions"
      && Array.isArray(reviewed.decisions), "reviewed-decisions.json 형식이 올바르지 않습니다");
    deletes = reviewed.decisions.filter((item) => item.decision === "delete").length;
    proposalCount = reviewed.decisions.length;
  } else {
    const proposal = proposalData(workspace, dataDir);
    assert(proposal.ready, "화면에서 결정을 저장하거나 proposal.json을 붙여넣으세요");
    assert(proposal.blockers.undecided === 0, "undecided 항목은 승인 전에 해결해야 합니다");
    assert(proposal.blockers.manualMoves === 0, "manual-move 항목은 자동 적용할 수 없습니다");
    deletes = proposal.items.filter((item) => item.suggestedDecision === "delete").length;
    proposalCount = proposal.items.length;
  }
  assert(deletes === 0 || confirmDeletes === true, `${deletes}개 삭제 후보에 대한 별도 확인이 필요합니다`);

  const statePath = stateFilePath(dataDir);
  const plansDir = join(pointer.runDir, "plans");
  const routingPath = join(pointer.runDir, "routing.json");
  let lockHeld = false;
  try {
    jobEvent(job, "lock", "로컬 유지관리 잠금을 획득합니다.");
    acquireLock({ dataDir });
    lockHeld = true;

    if (!existsSync(decisionsPath)) {
      writeJsonAtomic(decisionsPath, buildReviewedDecisions(pointer, readJson(pointer.proposalPath, "분류안")));
    }

    // 적용에 실패한 뒤 사용자가 결정을 바꿨을 수 있다. 최신 승인과 이미 컴파일된 계획이
    // 같은 결정에서 나왔는지 먼저 확인한다. 어긋나면 아직 적용 결과가 없을 때만 다시 만들고,
    // 영수증이 있으면 옛 계획을 실행하지도 지우지도 않고 여기서 멈춘다.
    const decisionsDigest = sha256(readFileSync(decisionsPath));
    const planSourcePath = join(pointer.runDir, PLAN_SOURCE_FILE);
    // 출처 파일이 깨졌으면 출처를 모르는 계획으로 취급한다(아래에서 영수증이 있으면 중단한다).
    let planSource = null;
    if (existsSync(planSourcePath)) {
      try { planSource = readJson(planSourcePath, "계획 출처"); } catch { planSource = null; }
    }
    const reuse = planReuseDecision({
      hasCompiledArtifacts: existsSync(plansDir) || existsSync(routingPath),
      stampDigest: planSource?.decisionsDigest || null,
      decisionsDigest,
      hasReceipts: receiptFileCount(join(pointer.runDir, "receipts")) > 0,
    });
    assert(reuse.action !== "halt", PLAN_HALT_MESSAGES[reuse.reason]);
    if (reuse.action === "recompile") {
      jobEvent(job, "compile", "결정이 바뀌어 아직 적용되지 않은 이전 계획을 버리고 다시 만듭니다.");
      rmSync(plansDir, { recursive: true, force: true });
      rmSync(routingPath, { force: true });
    }

    jobEvent(job, "compile", "승인된 제목·삭제·프로젝트 계획을 컴파일합니다.");
    if (!existsSync(plansDir)) {
      compileReviewedDecisions(pointer.inventoryPath, decisionsPath, plansDir);
    }
    let routingCompile = null;
    if (!existsSync(routingPath)) {
      routingCompile = compileProjectRouting(pointer.inventoryPath, decisionsPath, routingPath);
    } else {
      routingCompile = { routingRequired: true, routingPath };
    }
    if (reuse.action !== "reuse") {
      writeJsonAtomic(planSourcePath, {
        version: 1,
        kind: "compiled-plan-source",
        decisionsDigest,
        compiledAt: new Date().toISOString(),
      });
    }

    const hasManagementPlans = readdirSync(plansDir).some((name) => name.toLowerCase().endsWith(".json"));
    if (hasManagementPlans) {
      const prepare = preparePlanSet(plansDir);
      if (prepare.summary?.remainingActions > 0) {
        jobEvent(job, "apply", `${prepare.summary.remainingActions}개 제목 변경 또는 삭제를 적용합니다.`);
        const applied = await applyPlanSet({ plansDir, confirmation: prepare.summary.expectedConfirmation, accountId, api,
          onProgress: (event) => jobEvent(job, "apply", `${event.type}: ${basename(event.file || "batch")}`) });
        assert(applied.ok, applied.error || "제목 변경 또는 삭제 적용에 실패했습니다");
      }
    }

    jobEvent(job, "checkpoint", "적용 결과와 원격 상태를 검증합니다.");
    await checkpointMaintenanceRun({ inventoryPath: pointer.inventoryPath, decisionsPath, statePath,
      plansDir: hasManagementPlans ? plansDir : "", api });

    if (routingCompile.routingRequired) {
      const routing = validateProjectRouting(readJson(routingPath, "프로젝트 배치 계획"));
      const routingPrepare = prepareProjectRouting(routing);
      const routingStatus = projectRoutingStatus(routing);
      if (routingStatus.pendingTargets > 0) {
        jobEvent(job, "routing", `${routingPrepare.conversationCount}개 대화를 승인된 프로젝트에 배치합니다.`);
        const routed = await runProjectRouting({ routing, confirmation: routingPrepare.expectedConfirmation,
          accountId, api, pendingOnly: true,
          onProgress: (event) => jobEvent(job, "routing", `${event.type}: ${event.projectName}`) });
        assert(routed.ok, "프로젝트 배치에 실패했습니다");
      } else {
        jobEvent(job, "routing", "기존 영수증으로 프로젝트 배치 완료를 확인했습니다.");
      }
      jobEvent(job, "verify", "프로젝트 배치와 최종 기준선을 검증합니다.");
      await synchronizeMaintenanceStateAfterProjectRouting({ statePath, routingPath, api });
    }

    const state = readJson(statePath, "최종 기준선");
    const result = {
      counts: state.counts,
      deletes,
      proposalCount,
    };
    writePointer(workspace, { ...pointer, phase: "complete", result });
    jobEvent(job, "complete", "원격 적용과 기준선 갱신을 완료했습니다.");
    job.result = { phase: "complete", ...result };
  } finally {
    if (lockHeld) releaseLock({ dataDir });
  }
}

function startAsyncJob(job, stage, task) {
  queueMicrotask(async () => {
    try {
      await task();
      job.ok = true;
    } catch (error) {
      job.ok = false;
      job.error = createSafeDiagnostic(stage, error, job.workspace, job.result?.run?.runId || null);
      jobEvent(job, "error", job.error.message);
    } finally {
      job.done = true;
    }
  });
}

export async function handleMaintenanceWebRequest(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (!url.pathname.startsWith("/maintenance/")) return false;
  try {
    if (req.method === "GET" && url.pathname === "/maintenance/status") {
      jsonResponse(res, 200, workspaceStatus(url.searchParams.get("workspace") || APP_ROOT));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/maintenance/proposal") {
      const { workspace, dataDir } = validateMaintenanceWorkspace(url.searchParams.get("workspace") || APP_ROOT);
      jsonResponse(res, 200, proposalData(workspace, dataDir));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/maintenance/catalog") {
      const { workspace, dataDir } = validateMaintenanceWorkspace(url.searchParams.get("workspace") || APP_ROOT);
      jsonResponse(res, 200, catalogData(workspace, dataDir));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/maintenance/decisions") {
      const { workspace, dataDir } = validateMaintenanceWorkspace(url.searchParams.get("workspace") || APP_ROOT);
      jsonResponse(res, 200, reviewedDecisionsData(workspace, dataDir));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/maintenance/proposal") {
      const body = await readRequestJson(req);
      const { workspace, dataDir } = validateMaintenanceWorkspace(body.workspace || APP_ROOT);
      jsonResponse(res, 200, savePastedProposal(workspace, dataDir, body.proposalJson));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/maintenance/decisions") {
      const body = await readRequestJson(req);
      const { workspace, dataDir } = validateMaintenanceWorkspace(body.workspace || APP_ROOT);
      jsonResponse(res, 200, writeReviewedDecisions(workspace, dataDir, body.decisions));
      return true;
    }
    if (req.method === "GET" && url.pathname.startsWith("/maintenance/job/")) {
      const id = url.pathname.slice("/maintenance/job/".length);
      const job = jobs.get(id);
      if (!job) jsonResponse(res, 404, { error: { code: "JOB_NOT_FOUND", message: "작업 상태를 찾을 수 없습니다" } });
      else jsonResponse(res, 200, publicJob(job));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/maintenance/scan") {
      const body = await readRequestJson(req);
      const { workspace, dataDir } = validateMaintenanceWorkspace(body.workspace || APP_ROOT);
      assert(relayBroker.status().connected, "ChatGPT 릴레이가 연결되지 않았습니다 — chatgpt.com에서 북마클릿을 실행하세요");
      const job = createJob("scan", workspace);
      const api = relayApi(job);
      startAsyncJob(job, "scan", () => scanWorkflow(workspace, dataDir, api, job));
      jsonResponse(res, 202, { jobId: job.id });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/maintenance/apply") {
      const body = await readRequestJson(req);
      const { workspace, dataDir } = validateMaintenanceWorkspace(body.workspace || APP_ROOT);
      assert(relayBroker.status().connected, "ChatGPT 릴레이가 연결되지 않았습니다 — chatgpt.com에서 북마클릿을 실행하세요");
      const job = createJob("apply", workspace);
      const api = relayApi(job, 2000);
      startAsyncJob(job, "apply", async () => applyWorkflow(workspace, dataDir, api,
        await relayAccountId(api), body.confirmDeletes === true, job));
      jsonResponse(res, 202, { jobId: job.id });
      return true;
    }
    jsonResponse(res, 404, { error: { code: "NOT_FOUND", message: "지원하지 않는 유지관리 요청입니다" } });
    return true;
  } catch (error) {
    const workspace = url.searchParams.get("workspace") || APP_ROOT;
    jsonResponse(res, 400, { error: createSafeDiagnostic("request", error, workspace) });
    return true;
  }
}
