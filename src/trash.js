// 삭제후보 목록: 삭제후보를 곧바로 지우지 않고 삭제후보 프로젝트에 모아 두고 사용자가 ChatGPT에서
// 직접 확인한 뒤 남길 것과 지울 것을 정한다. 어떤 대화가 왜 보관됐는지는 data/trash.json 에 남는다.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "./fs-json.js";

const FILE = "trash.json";

function pathOf(dataDir) { return join(dataDir, FILE); }

export function readTrash(dataDir) {
  try {
    const data = JSON.parse(readFileSync(pathOf(dataDir), "utf8"));
    if (data?.version === 1 && Array.isArray(data.items)) return data;
  } catch {}
  return { version: 1, project: null, items: [] };
}

const write = (dataDir, value) => writeJsonAtomic(pathOf(dataDir), value);

// items: [{conversationId, title, fromProject, reason, intendedTarget, backupFile, backupSha256}]
export function addTrashed(dataDir, { project, items, now = () => new Date() }) {
  const current = readTrash(dataDir);
  const byId = new Map(current.items.map((item) => [item.conversationId, item]));
  for (const item of items) {
    byId.set(item.conversationId, { ...byId.get(item.conversationId), ...item, trashedAt: now().toISOString() });
  }
  const next = { version: 1, project, items: [...byId.values()] };
  write(dataDir, next);
  return next;
}

export function removeTrashed(dataDir, ids) {
  const drop = new Set(ids);
  const current = readTrash(dataDir);
  const next = { ...current, items: current.items.filter((item) => !drop.has(item.conversationId)) };
  write(dataDir, next);
  return next;
}
