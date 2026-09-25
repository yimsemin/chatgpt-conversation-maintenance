// 대화 카탈로그 수집: 프로젝트를 순회하는 전체 수집(crawl), 목록 응답의 gizmo_id 로 소속을 알아내는 빠른 수집,
// 최근 수정 순 목록의 앞부분만 읽는 증분 수집, 그리고 빠른 수집이 crawl 과 같은 결과인지 재는 검증(probe).
import { assert } from "./assert.js";
import { CONVERSATION_ID } from "./ids.js";

export const PAGE_SIZE = 100;
export const PROJECT_PAGE_SIZE = 20;
export const PROJECT_CONVERSATION_PAGE_SIZE = 50;

// 같은 시각이 엔드포인트에 따라 ISO 문자열이나 epoch 초 실수로 오므로 정수 밀리초로 맞춘다.
// Date.parse 는 밀리초 아래를 버리므로 실수 쪽도 내림해야 같은 값이 된다.
export function timeMilliseconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value > 1e12 ? value : value * 1000);
  }
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

// 한쪽 시각을 알 수 없으면 "바뀌었다"로 보지 않는다. 대화 목록 엔드포인트는 항목을
// 수정시각 순으로 주고 offset 으로 페이지를 넘기므로, 제목을 대량 변경한 직후에는
// 일부 대화가 주 목록에서 밀려 프로젝트 목록에서만 수집된다. 그 응답에는 create_time 이
// 없을 수 있는데, 정보가 없는 것을 변경 증거로 취급하면 실제로 바뀌지 않은 대화 때문에
// 전체 작업이 멈춘다(2026-09-12 실측: createTime 드리프트로 checkpoint 2회 실패).
export function sameTime(left, right) {
  const a = timeMilliseconds(left);
  const b = timeMilliseconds(right);
  if (a === null || b === null) return true;
  return a === b;
}

export function projectCatalog(projects, conversations) {
  return projects
    .map((project) => {
      const projectConversations = conversations
        .filter((conversation) => conversation.projectName === project.projectName)
        .sort((left, right) => {
          const timeDifference = (timeMilliseconds(right.updateTime) ?? 0)
            - (timeMilliseconds(left.updateTime) ?? 0);
          return timeDifference || left.conversationId.localeCompare(right.conversationId);
        });
      return {
        projectName: project.projectName,
        conversationCount: projectConversations.length,
        sampleTitles: projectConversations.slice(0, 5).map((conversation) => conversation.title),
      };
    })
    .sort((left, right) => left.projectName.localeCompare(right.projectName));
}

export function unwrap(response, label) {
  assert(response.ok, `${label} failed: HTTP ${response.status}`);
  assert(response.data && typeof response.data === "object", `${label} returned invalid JSON`);
  return response.data;
}

// 사이드바 응답은 프로젝트를 여러 깊이로 감싸서 준다(`resource.gizmo`, `gizmo`, 또는 항목 자체).
// 관측된 래핑을 차례로 벗겨 가장 안쪽 객체를 돌려준다.
export function unwrapSidebarGizmo(entry) {
  let current = entry && typeof entry === "object" ? entry : {};
  for (let depth = 0; depth < 3; depth++) {
    const inner = current.resource?.gizmo ?? current.gizmo;
    if (!inner || typeof inner !== "object") break;
    current = inner;
  }
  return current;
}

// 소유 프로젝트(ID·이름)를 모두 찾는다.
export async function discoverProjects(api) {
  const projects = [];
  let projectCursor = null;
  const seenProjectCursors = new Set();
  while (true) {
    const data = unwrap(
      await api.listProjectSidebar({ cursor: projectCursor || "", limit: PROJECT_PAGE_SIZE }),
      "Project discovery");
    const items = data.list?.items || data.items || [];
    if (!items.length) break;
    for (const entry of items) {
      const gizmo = unwrapSidebarGizmo(entry);
      const projectId = gizmo.id || "";
      if (!projectId.startsWith("g-p-")) continue;
      projects.push({
        projectId,
        projectName: gizmo.display?.name || gizmo.name || projectId,
      });
    }
    const next = data.list?.cursor || data.cursor || data.next_cursor || null;
    if (!next) break;
    assert(!seenProjectCursors.has(next), "Project pagination cursor repeated");
    seenProjectCursors.add(next);
    projectCursor = next;
  }
  return projects;
}

export async function collectConversationCatalog(api, now = () => new Date(), onProgress = () => {}) {
  assert(api?.listProjectSidebar && api?.listProjectConversations && api?.listConversations,
    "Catalog API adapter is incomplete");
  onProgress({ phase: "projects", index: 0, total: null });
  const projects = await discoverProjects(api);

  const projectByConversation = new Map();
  const projectExtras = new Map();
  for (const [projectIndex, project] of projects.entries()) {
    onProgress({ phase: "projects", index: projectIndex, total: projects.length, projectName: project.projectName });
    let cursor = null;
    const seenCursors = new Set();
    while (true) {
      const data = unwrap(
        await api.listProjectConversations(project.projectId,
          { cursor: cursor || "", limit: PROJECT_CONVERSATION_PAGE_SIZE }),
        `Conversation discovery for project "${project.projectName}"`);
      const items = data.items || data.conversations || [];
      if (!items.length) break;
      for (const item of items) {
        if (!CONVERSATION_ID.test(item.id || "")) continue;
        projectByConversation.set(item.id, project.projectName);
        projectExtras.set(item.id, { ...item, projectName: project.projectName });
      }
      const next = data.list?.cursor || data.cursor || data.next_cursor || null;
      if (!next) break;
      assert(!seenCursors.has(next), `Conversation pagination cursor repeated for "${project.projectName}"`);
      seenCursors.add(next);
      cursor = next;
    }
  }

  const conversationById = new Map();
  for (const isArchived of [false, true]) {
    let offset = 0;
    const seenPages = new Set();
    while (true) {
      const data = unwrap(
        await api.listConversations({ archived: isArchived, offset, limit: PAGE_SIZE }),
        `${isArchived ? "Archived" : "Active"} conversation discovery`);
      const items = data.items || [];
      if (!items.length) break;
      const pageKey = `${items[0]?.id || ""}:${items.at(-1)?.id || ""}:${items.length}`;
      assert(!seenPages.has(pageKey), `Conversation pagination stalled at offset ${offset}`);
      seenPages.add(pageKey);
      for (const item of items) {
        if (!CONVERSATION_ID.test(item.id || "")) continue;
        conversationById.set(item.id, {
          ...item,
          is_archived: item.is_archived === true || isArchived,
          projectName: projectByConversation.get(item.id) || null,
        });
      }
      offset += items.length;
      const total = Number.isFinite(data.total) ? data.total : null;
      onProgress({ phase: isArchived ? "archived" : "active", index: offset, total });
      const hasNext = data.has_next ?? data.has_more;
      if (hasNext === false) break;
      if (hasNext !== true && total !== null && offset >= total) break;
      if (hasNext !== true && total === null && items.length < PAGE_SIZE) break;
    }
  }
  for (const [id, item] of projectExtras) {
    if (!conversationById.has(id)) conversationById.set(id, item);
  }

  return buildCatalog({ projects, now, conversations: [...conversationById.values()].map((item) => ({
    conversationId: item.id,
    title: typeof item.title === "string" && item.title.trim() ? item.title : "Untitled",
    createTime: item.create_time ?? null,
    updateTime: item.update_time ?? null,
    isArchived: item.is_archived === true,
    projectName: item.projectName || projectByConversation.get(item.id) || null,
  })) });
}

export function buildCatalog({ projects, conversations, now = () => new Date() }) {
  conversations = [...conversations].sort((left, right) => left.conversationId.localeCompare(right.conversationId));
  const projectContext = projectCatalog(projects, conversations);

  return {
    version: 1,
    kind: "conversation-maintenance-catalog",
    generatedAt: now().toISOString(),
    scope: {
      activeConversations: true,
      archivedConversations: true,
      projectDiscovery: "owned_only",
    },
    counts: {
      conversations: conversations.length,
      active: conversations.filter((item) => !item.isArchived).length,
      archived: conversations.filter((item) => item.isArchived).length,
      unassigned: conversations.filter((item) => !item.projectName).length,
      projects: projects.length,
    },
    projects: projectContext,
    conversations,
  };
}

export function catalogFrom(base, conversations, now) {
  return {
    ...base,
    generatedAt: now().toISOString(),
    counts: {
      ...base.counts,
      conversations: conversations.length,
      active: conversations.filter((item) => !item.isArchived).length,
      archived: conversations.filter((item) => item.isArchived).length,
      unassigned: conversations.filter((item) => !item.projectName).length,
    },
    projects: projectCatalog(base.projects, conversations),
    conversations,
  };
}


// ---- 빠른 수집 ----

export class FastCatalogUnsupported extends Error {
  constructor(message) { super(message); this.name = "FastCatalogUnsupported"; }
}

function listItemToConversation(item, projectById, isArchived) {
  const project = PROJECT_ID_PREFIX.test(item.gizmo_id || "") ? projectById.get(item.gizmo_id) || null : null;
  return {
    conversationId: item.id,
    title: typeof item.title === "string" && item.title.trim() ? item.title : "Untitled",
    createTime: item.create_time ?? null,
    updateTime: item.update_time ?? null,
    isArchived: item.is_archived === true || isArchived,
    projectName: project,
  };
}
const PROJECT_ID_PREFIX = /^g-p-/;

// 목록 응답에 gizmo_id 가 있어야 프로젝트 소속을 알 수 있다. 필드 자체가 없으면 지원하지 않는 것이다.
function assertHasGizmoField(items) {
  if (items.length && !items.some((item) => Object.hasOwn(item, "gizmo_id"))) {
    throw new FastCatalogUnsupported("대화 목록 응답에 gizmo_id 가 없어 프로젝트 소속을 알 수 없습니다");
  }
}

// 프로젝트를 돌지 않고 목록의 gizmo_id 로 소속을 정한다. 요청 수가 프로젝트 수만큼 줄어든다.
export async function collectFastCatalog(api, now = () => new Date(), onProgress = () => {}) {
  onProgress({ phase: "projects", index: 0, total: null });
  const projects = await discoverProjects(api);
  const projectById = new Map(projects.map((project) => [project.projectId, project.projectName]));
  const byId = new Map();
  for (const isArchived of [false, true]) {
    let offset = 0;
    const seenPages = new Set();
    while (true) {
      const data = unwrap(await api.listConversations({ archived: isArchived, offset, limit: PAGE_SIZE }),
        `${isArchived ? "Archived" : "Active"} conversation discovery`);
      const items = data.items || [];
      if (!items.length) break;
      assertHasGizmoField(items);
      const pageKey = `${items[0]?.id || ""}:${items.at(-1)?.id || ""}:${items.length}`;
      assert(!seenPages.has(pageKey), `Conversation pagination stalled at offset ${offset}`);
      seenPages.add(pageKey);
      for (const item of items) {
        if (CONVERSATION_ID.test(item.id || "")) byId.set(item.id, listItemToConversation(item, projectById, isArchived));
      }
      offset += items.length;
      const total = Number.isFinite(data.total) ? data.total : null;
      onProgress({ phase: isArchived ? "archived" : "active", index: offset, total });
      const hasNext = data.has_next ?? data.has_more;
      if (hasNext === false) break;
      if (hasNext !== true && total !== null && offset >= total) break;
      if (hasNext !== true && total === null && items.length < PAGE_SIZE) break;
    }
  }
  return buildCatalog({ projects, conversations: [...byId.values()], now });
}

// ---- 증분 수집 ----
// 최근 수정 순 목록에서 기준선과 같은 항목이 stopAfterUnchanged 개 연속되면 멈춘다. 그 뒤의 항목은
// 더 오래전에 마지막으로 수정됐으므로 기준선과 같다고 본다. 삭제된 대화는 이 방식으로 알 수 없다.
export async function collectIncrementalCatalog({ api, baseline, now = () => new Date(), onProgress = () => {},
  stopAfterUnchanged = 30, maxPages = 30 }) {
  onProgress({ phase: "projects", index: 0, total: null });
  const projects = await discoverProjects(api);
  const projectById = new Map(projects.map((project) => [project.projectId, project.projectName]));
  const known = new Map(baseline.conversations.map((item) => [item.conversationId, item]));
  const merged = new Map(known);
  let changed = 0;
  let pages = 0;

  const sameAsKnown = (entry, previous) => Boolean(previous)
    && previous.title === entry.title
    && sameTime(previous.updateTime, entry.updateTime)
    && previous.isArchived === entry.isArchived
    && (previous.projectName || null) === (entry.projectName || null);

  for (const isArchived of [false, true]) {
    let unchangedRun = 0;
    for (let page = 0; page < (isArchived ? 1 : maxPages); page++) {
      const data = unwrap(await api.listConversations({ archived: isArchived, offset: page * PAGE_SIZE, limit: PAGE_SIZE }),
        `${isArchived ? "Archived" : "Recent"} conversation discovery`);
      const items = data.items || [];
      pages += 1;
      onProgress({ phase: "recent", index: page + 1, total: null });
      if (!items.length) break;
      assertHasGizmoField(items);
      for (const item of items) {
        if (!CONVERSATION_ID.test(item.id || "")) continue;
        const entry = listItemToConversation(item, projectById, isArchived);
        if (sameAsKnown(entry, known.get(entry.conversationId))) { unchangedRun += 1; }
        else { merged.set(entry.conversationId, entry); changed += 1; unchangedRun = 0; }
        if (unchangedRun >= stopAfterUnchanged) break;
      }
      if (unchangedRun >= stopAfterUnchanged) break;
      if (data.has_next === false || items.length < PAGE_SIZE) break;
    }
  }
  const catalog = buildCatalog({ projects, conversations: [...merged.values()], now });
  return { catalog, changed, pages };
}

// ---- 검증(probe): 빠른 수집이 전체 수집과 같은 결과를 내는가 ----
export async function probeFastCatalog(api, { now = () => new Date(), onProgress = () => {} } = {}) {
  const crawl = await collectConversationCatalog(api, now, onProgress);
  let fast;
  try {
    fast = await collectFastCatalog(api, now, (info) => onProgress({ ...info, phase: `fast-${info.phase}` }));
  } catch (error) {
    if (error instanceof FastCatalogUnsupported) {
      return { ok: false, reason: "unsupported", message: error.message, total: crawl.conversations.length,
        checkedAt: now().toISOString() };
    }
    throw error;
  }
  const crawlById = new Map(crawl.conversations.map((item) => [item.conversationId, item]));
  const fastById = new Map(fast.conversations.map((item) => [item.conversationId, item]));
  const samples = [];
  const counts = { missingInFast: 0, missingInCrawl: 0, project: 0, title: 0, archived: 0 };
  for (const [id, item] of crawlById) {
    const other = fastById.get(id);
    if (!other) { counts.missingInFast += 1; samples.push({ id, kind: "missingInFast" }); continue; }
    if ((item.projectName || null) !== (other.projectName || null)) {
      counts.project += 1; samples.push({ id, kind: "project", crawl: item.projectName, fast: other.projectName });
    }
    if (item.title !== other.title) counts.title += 1;
    if (item.isArchived !== other.isArchived) counts.archived += 1;
  }
  for (const id of fastById.keys()) if (!crawlById.has(id)) counts.missingInCrawl += 1;
  const ok = counts.missingInFast === 0 && counts.missingInCrawl === 0 && counts.project === 0;
  return { ok, reason: ok ? null : "mismatch", total: crawl.conversations.length, counts,
    samples: samples.slice(0, 10), checkedAt: now().toISOString() };
}
