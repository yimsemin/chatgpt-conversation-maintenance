// 기준선(state.json) 만들기: 처음 시작, 사용자의 직접 정리 결과 반영(기준선 확정), 검증된 카탈로그로부터의 상태 구성.
import { assert } from "./assert.js";
import { catalogFrom } from "./catalog.js";

export function maintenanceState(catalog, source = null) {
  return {
    version: 1,
    kind: "conversation-maintenance-state",
    generatedAt: catalog.generatedAt,
    ...(source ? { source } : {}),
    scope: catalog.scope,
    counts: catalog.counts,
    projects: catalog.projects,
    conversations: catalog.conversations,
  };
}

// 기준선 확정: 사용자가 ChatGPT에서 직접 정리한 결과(이동·제목 변경·삭제)를 알려진 대화에 한해 받아들인다.
// 기준선에 없던 새 대화는 넣지 않는다 — 다음 스캔에서 새 후보로 남는다. 전체 수집 결과가 입력이다.
export function rebaselineState({ state, catalog, now = () => new Date() }) {
  const known = new Map(state.conversations.map((item) => [item.conversationId, item]));
  const current = new Map(catalog.conversations.map((item) => [item.conversationId, item]));
  const diff = { removed: [], moved: [], renamed: [], archivedChanged: [], newConversationIds: [] };
  for (const [id, before] of known) {
    const after = current.get(id);
    if (!after) { diff.removed.push({ conversationId: id, title: before.title, project: before.projectName || null }); continue; }
    if ((before.projectName || null) !== (after.projectName || null)) {
      diff.moved.push({ conversationId: id, title: after.title, from: before.projectName || null, to: after.projectName || null });
    }
    if (before.title !== after.title) diff.renamed.push({ conversationId: id, from: before.title, to: after.title });
    if (before.isArchived !== after.isArchived) diff.archivedChanged.push({ conversationId: id, title: after.title });
  }
  for (const id of current.keys()) if (!known.has(id)) diff.newConversationIds.push(id);
  const tracked = catalog.conversations.filter((item) => known.has(item.conversationId));
  const nextCatalog = catalogFrom({ ...catalog, generatedAt: now().toISOString() }, tracked, now);
  return {
    diff,
    state: maintenanceState(nextCatalog, { verification: "full", rebaseline: true,
      deferredNewConversationIds: diff.newConversationIds.sort() }),
  };
}

// 처음 시작할 때의 기준선. accept 는 지금까지의 모든 대화를 이미 정리된 것으로 받아들이고(앞으로 새 대화만 정리),
// empty 는 아무것도 받아들이지 않아 다음 확인에서 모든 대화가 후보가 된다(처음부터 전체 정리).
export function initialBaselineState({ catalog, mode, now = () => new Date() }) {
  assert(["accept", "empty"].includes(mode), "mode must be accept or empty");
  const base = mode === "accept" ? catalog : catalogFrom(catalog, [], now);
  return maintenanceState(base, { verification: "full", initial: true, mode });
}
