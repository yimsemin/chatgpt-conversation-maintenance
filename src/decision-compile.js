// 사용자가 검토한 결정을 실행 계획(제목·삭제 배치, 프로젝트 배치)으로 컴파일한다.
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { assert } from "./assert.js";
import { readJson, writeJsonAtomic } from "./fs-json.js";
import { sha256 } from "./content-hash.js";
import { managementManifestDigest, validateManagementManifest } from "./management.js";
import { projectRoutingDigest, validateProjectRouting } from "./project-routing.js";
import { isNormalizedTitle } from "./title-rules.js";
import { timeMilliseconds } from "./catalog.js";

const MAINTENANCE_DECISIONS = new Set(["keep", "delete"]);

// 보존 대화의 프로젝트는 선택이다(프로젝트 없음이 정상). 값이 있으면 다듬어진 이름이어야 한다.
export function assertOptionalProjectName(value, label) {
  if (value === undefined || value === null) return;
  assert(typeof value === "string" && value.trim() === value && value.length > 0,
    `${label} must be empty or a trimmed project name`);
}

// 인벤토리와 승인 파일을 읽어 머리 정보(형식·경고·해시)를 검증한다. 컴파일과 결과 확정이 같은 규칙을 쓴다.
export function loadReviewedRun(inventoryPath, decisionsPath) {
  const inventoryRaw = readFileSync(inventoryPath);
  const decisionsRaw = readFileSync(decisionsPath);
  const inventory = readJson(inventoryPath, "Inventory");
  const decisionsFile = readJson(decisionsPath, "Reviewed decisions");
  const inventoryDigest = sha256(inventoryRaw);
  assert(inventory?.version === 1 && inventory.kind === "conversation-maintenance-inventory", "Unsupported inventory format");
  assert(Array.isArray(inventory.warnings) && inventory.warnings.length === 0,
    `Inventory is not safe to use: ${(inventory.warnings || ["missing warnings field"]).join("; ")}`);
  assert(decisionsFile?.version === 1 && decisionsFile.kind === "reviewed-decisions", "Unsupported reviewed decisions format");
  assert(decisionsFile.inventoryDigest === inventoryDigest, "Reviewed decisions do not match the inventory digest");
  assert(Array.isArray(decisionsFile.decisions), "Reviewed decisions are missing");
  return { inventory, decisionsFile, inventoryDigest, decisionsDigest: sha256(decisionsRaw) };
}

// 승인된 결정 전체의 공통 규칙: 후보마다 정확히 하나, 사람이 검토함, 보존 또는 삭제,
// 삭제에는 제목·프로젝트가 없고 보존에는 표준 제목이 있다. 결정과 그 후보 원본을 짝지어 돌려준다.
export function reviewedPairs(inventory, decisionsFile) {
  const inventoryById = new Map(inventory.conversations.map((item) => [item.conversationId, item]));
  const seen = new Set();
  const pairs = decisionsFile.decisions.map((decision, index) => {
    const label = `decisions[${index}]`;
    assert(decision && typeof decision === "object", `${label} must be an object`);
    assert(decision.reviewed === true, `${label} was not reviewed by the user`);
    assert(!seen.has(decision.conversationId), `${label}.conversationId is duplicated`);
    seen.add(decision.conversationId);
    const source = inventoryById.get(decision.conversationId);
    assert(source, `${label}.conversationId is not present in the inventory`);
    assert(MAINTENANCE_DECISIONS.has(decision.decision), `${label}.decision must be keep or delete (unsupported: ${decision.decision})`);
    const newTitle = decision.newTitle;
    if (newTitle !== undefined) assert(typeof newTitle === "string" && newTitle.trim(), `${label}.newTitle is invalid`);
    if (decision.decision === "delete") {
      assert(!newTitle, `${label} cannot rename a conversation that will be deleted`);
      assert(decision.projectName === undefined || decision.projectName === null,
        `${label}.projectName must be empty for a deleted conversation`);
    } else {
      // 삭제후보 프로젝트로 옮기는 대화도 표준 제목을 갖는다.
      assert((decision.keepTitle === true && !newTitle) || isNormalizedTitle(newTitle || source.title),
        `${label} must preserve or set the exact "topic — work/result" title form`);
      assertOptionalProjectName(decision.projectName, `${label}.projectName`);
      assert(!(decision.trashed === true && decision.marked === true), `${label} cannot be both moved to the trash project and only marked`);
    }
    return { decision, source };
  });
  assert(seen.size === inventory.conversations.length,
    "Every maintenance candidate must have exactly one reviewed decision");
  return pairs;
}

// 제목 변경은 그 대화의 수정 시각을 변경 시각으로 올려 목록 순서를 바꾼다(2026-09-26 실측, docs/GOALS.md).
// 오래된 대화부터 바꾸면 바꾼 대화끼리는 원래의 상대 순서가 유지되므로 계획을 수정 시각 오름차순으로 만든다.
// 수정 시각을 모르는 대화는 가장 앞에 두고, 같은 시각이면 대화 ID 순이라 계획이 항상 같다.
export function orderOldestFirst(actions, inventoryById) {
  const time = (action) => timeMilliseconds(inventoryById.get(action.conversationId)?.updateTime) ?? -Infinity;
  return [...actions].sort((left, right) => (time(left) === time(right) ? 0 : time(left) < time(right) ? -1 : 1)
    || left.conversationId.localeCompare(right.conversationId));
}

export function compileReviewedDecisions(inventoryPath, decisionsPath, outputDir) {
  const { inventory, decisionsFile: decisions, inventoryDigest, decisionsDigest } = loadReviewedRun(inventoryPath, decisionsPath);
  assert(isAbsolute(decisions.receiptDir || ""), "Reviewed decisions require an absolute receiptDir");
  const inventoryById = new Map(inventory.conversations.map((item) => [item.conversationId, item]));
  const actions = [];
  // 프로젝트 간 이동은 compileProjectRouting()/runProjectRouting()이 맡는다. 여기서는 제목·삭제 배치만 만든다.
  for (const { decision, source } of reviewedPairs(inventory, decisions)) {
    if (decision.decision === "keep" && !decision.newTitle) continue;
    actions.push({
      conversationId: source.conversationId,
      expectedTitle: source.title,
      decision: decision.decision,
      approved: true,
      backupFile: source.backupFile,
      backupSha256: source.backupSha256,
      ...(decision.newTitle ? { newTitle: decision.newTitle } : {}),
    });
  }
  const outDir = resolve(outputDir);
  mkdirSync(outDir, { recursive: true });
  assert(readdirSync(outDir).length === 0, `Output directory is not empty: ${outDir}`);

  const ordered = orderOldestFirst(actions, inventoryById);
  const manifests = [];
  for (let offset = 0; offset < ordered.length; offset += 25) {
    const manifest = validateManagementManifest({
      version: 1,
      workspace: "business",
      receiptDir: resolve(decisions.receiptDir),
      source: { inventoryDigest, decisionsDigest },
      actions: ordered.slice(offset, offset + 25),
    });
    const number = String(manifests.length + 1).padStart(3, "0");
    const path = join(outDir, `batch-${number}.json`);
    writeJsonAtomic(path, manifest, { exclusive: true });
    manifests.push({ path, actions: manifest.actions.length, digest: managementManifestDigest(manifest) });
  }
  return { inventoryDigest, decisionsDigest, skippedKeep: decisions.decisions.length - actions.length, manifests };
}

export function compileProjectRouting(inventoryPath, decisionsPath, outputPath) {
  const { inventory, decisionsFile: decisions, inventoryDigest, decisionsDigest } = loadReviewedRun(inventoryPath, decisionsPath);
  assert(isAbsolute(decisions.receiptDir || ""), "Reviewed decisions require an absolute receiptDir");
  const targetsByName = new Map();
  for (const { decision, source } of reviewedPairs(inventory, decisions)) {
    if (decision.decision === "delete") continue;
    // 프로젝트 없음이면 옮길 곳이 없다. 이미 프로젝트 안이면 사용자가 수동으로 뺀다.
    if (decision.projectName === undefined || decision.projectName === null) continue;
    if (source.projectName && decision.projectName === source.projectName) continue;
    const entry = targetsByName.get(decision.projectName) || { actions: [], sourceProjectNames: {} };
    entry.actions.push({
      conversationId: source.conversationId,
      expectedTitle: decision.newTitle || source.title,
      expectedSourceProjectId: null,
      approved: true,
    });
    if (source.projectName) {
      entry.sourceProjectNames[source.conversationId] = source.projectName;
    }
    targetsByName.set(decision.projectName, entry);
  }

  if (targetsByName.size === 0) {
    return { inventoryDigest, decisionsDigest, routingRequired: false };
  }
  const routing = validateProjectRouting({
    version: 1,
    kind: "chatgpt-project-routing",
    workspace: "business",
    receiptDir: resolve(decisions.receiptDir),
    // 배치 계획 하나는 25건까지다. 큰 프로젝트는 같은 프로젝트를 가리키는 타깃 여러 개로 나눈다.
    targets: [...targetsByName.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([name, entry]) => {
        const chunks = [];
        for (let offset = 0; offset < entry.actions.length; offset += 25) {
          const actions = entry.actions.slice(offset, offset + 25);
          const ids = new Set(actions.map((action) => action.conversationId));
          chunks.push({
            project: { name, instructions: "", createIfMissing: true, approved: true },
            actions,
            sourceProjectNames: Object.fromEntries(
              Object.entries(entry.sourceProjectNames).filter(([id]) => ids.has(id))),
          });
        }
        return chunks;
      }),
  });
  writeJsonAtomic(resolve(outputPath), routing, { exclusive: true });
  return {
    inventoryDigest,
    decisionsDigest,
    routingRequired: true,
    routingPath: resolve(outputPath),
    routingDigest: projectRoutingDigest(routing),
    targetCount: routing.targets.length,
    conversationCount: routing.targets.reduce((sum, target) => sum + target.actions.length, 0),
  };
}
