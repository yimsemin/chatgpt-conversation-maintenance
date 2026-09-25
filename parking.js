// 검토 대기(임시 보관): 삭제 후보를 곧바로 지우지 않고 지정한 프로젝트에 모아 두고 사용자가 ChatGPT에서
// 직접 확인한 뒤 남길 것과 지울 것을 정한다. 어떤 대화가 왜 보관됐는지는 data/parking.json 에 남는다.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const FILE = "parking.json";

function pathOf(dataDir) { return join(dataDir, FILE); }

export function readParking(dataDir) {
  try {
    const data = JSON.parse(readFileSync(pathOf(dataDir), "utf8"));
    if (data?.version === 1 && Array.isArray(data.items)) return data;
  } catch {}
  return { version: 1, project: null, items: [] };
}

function write(dataDir, value) {
  const path = pathOf(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const partial = `${path}.partial-${randomUUID()}`;
  writeFileSync(partial, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(partial, path);
}

// items: [{conversationId, title, fromProject, reason, intendedTarget, backupFile, backupSha256}]
export function addParked(dataDir, { project, items, now = () => new Date() }) {
  const current = readParking(dataDir);
  const byId = new Map(current.items.map((item) => [item.conversationId, item]));
  for (const item of items) {
    byId.set(item.conversationId, { ...byId.get(item.conversationId), ...item, parkedAt: now().toISOString() });
  }
  const next = { version: 1, project, items: [...byId.values()] };
  write(dataDir, next);
  return next;
}

export function removeParked(dataDir, ids) {
  const drop = new Set(ids);
  const current = readParking(dataDir);
  const next = { ...current, items: current.items.filter((item) => !drop.has(item.conversationId)) };
  write(dataDir, next);
  return next;
}
