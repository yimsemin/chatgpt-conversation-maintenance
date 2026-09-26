// 대화 카탈로그 수집. 범위(scope)에 따라 두 가지다.
// - 전체 수집(collectConversationCatalog): 프로젝트를 순회하며 모든 활성·보관 대화를 읽는다. 완전하다.
// - 범위 수집(collectScopedCatalog): 고른 범위의 활성 대화만 읽는다(프로젝트 범위는 그 프로젝트만, 나머지는 목록 기준).
// 전체 대화 목록 응답에는 프로젝트 대화가 일부 빠져 있어(2026-09-25 실측, API_COMPATIBILITY.md) 목록만으로는 프로젝트 안의 대화를 다 못 찾는다.
// 프로젝트 없는 대화는 그 실측에서 빠진 적이 없어 목록으로 찾는다.
import { assert } from "./assert.js";
import { CONVERSATION_ID } from "./ids.js";

export const PAGE_SIZE = 100;
const PROJECT_PAGE_SIZE = 20;
const PROJECT_CONVERSATION_PAGE_SIZE = 50;

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
// 전체 작업이 멈춘다(2026-09-12 실측: createTime 드리프트로 검증 2회 실패).
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
async function discoverProjects(api) {
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

// 소유한 프로젝트 이름 목록(요청 1~2회).
export async function listProjectNames(api) {
  return (await discoverProjects(api)).map((project) => project.projectName);
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

const SAMPLE_PAGE_SIZE = 10;

// 프로젝트 하나의 대화를 (한 페이지 또는 끝까지) 읽는다. onlyFirstPage 는 프로젝트 성격을 알려 주는 표본 제목용이다.
async function readProjectConversations(api, project, { onlyFirstPage = false } = {}) {
  const items = [];
  let cursor = null;
  const seenCursors = new Set();
  while (true) {
    const data = unwrap(
      await api.listProjectConversations(project.projectId,
        { cursor: cursor || "", limit: onlyFirstPage ? SAMPLE_PAGE_SIZE : PROJECT_CONVERSATION_PAGE_SIZE }),
      `Conversation discovery for project "${project.projectName}"`);
    const page = data.items || data.conversations || [];
    if (!page.length) break;
    for (const item of page) if (CONVERSATION_ID.test(item.id || "")) items.push({ ...item, projectName: project.projectName });
    const next = data.list?.cursor || data.cursor || data.next_cursor || null;
    if (onlyFirstPage || !next) break;
    assert(!seenCursors.has(next), `Conversation pagination cursor repeated for "${project.projectName}"`);
    seenCursors.add(next);
    cursor = next;
  }
  return items;
}

function catalogRecord(item, projectName) {
  return {
    conversationId: item.id,
    title: typeof item.title === "string" && item.title.trim() ? item.title : "Untitled",
    createTime: item.create_time ?? null,
    updateTime: item.update_time ?? null,
    isArchived: item.is_archived === true,
    projectName: projectName ?? null,
  };
}

// 범위 수집. scope.kind: "project"(projectName) | "unassigned" | "recent"(days). 완전 수집은 collectConversationCatalog 다.
// 반환하는 카탈로그는 complete:false 이며, 읽지 않은 프로젝트의 대화 수는 null 이다(요약이 그 수를 지어내지 않게).
export async function collectScopedCatalog(api, scope, now = () => new Date(), onProgress = () => {}) {
  assert(api?.listProjectSidebar && api?.listProjectConversations && api?.listConversations,
    "Catalog API adapter is incomplete");
  assert(["project", "unassigned", "recent"].includes(scope?.kind), "Unsupported scope");
  onProgress({ phase: "projects", index: 0, total: null });
  const projects = await discoverProjects(api);
  const nameById = new Map(projects.map((project) => [project.projectId, project.projectName]));
  const records = new Map();
  const known = new Map(); // 프로젝트 이름 -> { count, samples }

  if (scope.kind === "project") {
    const target = projects.find((project) => project.projectName === scope.projectName);
    assert(target, `프로젝트를 찾을 수 없습니다: ${scope.projectName}`);
    onProgress({ phase: "projects", index: 0, total: 1, projectName: target.projectName });
    const items = await readProjectConversations(api, target);
    for (const item of items) records.set(item.id, catalogRecord(item, target.projectName));
    known.set(target.projectName, { count: items.length, samples: items.slice(0, 5).map((item) => item.title).filter(Boolean) });
  } else {
    // 다른 프로젝트로 옮길 후보를 고르는 데 쓰이도록 프로젝트마다 표본 제목만 읽는다.
    for (const [index, project] of projects.entries()) {
      onProgress({ phase: "projects", index, total: projects.length, projectName: project.projectName });
      const items = await readProjectConversations(api, project, { onlyFirstPage: true });
      known.set(project.projectName, { count: null, samples: items.slice(0, 5).map((item) => item.title).filter(Boolean) });
    }
    const cutoff = scope.kind === "recent" ? now().getTime() - scope.days * 86400000 : null;
    let offset = 0;
    const seenPages = new Set();
    listing: while (true) {
      const data = unwrap(await api.listConversations({ archived: false, offset, limit: PAGE_SIZE }), "Active conversation discovery");
      const items = data.items || [];
      if (!items.length) break;
      const pageKey = `${items[0]?.id || ""}:${items.at(-1)?.id || ""}:${items.length}`;
      assert(!seenPages.has(pageKey), `Conversation pagination stalled at offset ${offset}`);
      seenPages.add(pageKey);
      for (const item of items) {
        if (!CONVERSATION_ID.test(item.id || "")) continue;
        const updated = timeMilliseconds(item.update_time);
        // 목록은 수정 시각 순이므로 기간보다 오래된 항목이 나오면 그 뒤는 볼 필요가 없다.
        if (cutoff !== null && updated !== null && updated < cutoff) break listing;
        const gizmo = typeof item.gizmo_id === "string" ? item.gizmo_id : "";
        // 프로젝트(g-p-) 대화는 이름을 알아야 다루므로, 이름을 모르는 프로젝트의 대화는 제외한다.
        // g- 로 시작하는 다른 값은 사용자 정의 GPT 이므로 프로젝트 없음으로 본다.
        if (gizmo.startsWith("g-p-") && !nameById.has(gizmo)) continue;
        const projectName = gizmo.startsWith("g-p-") ? nameById.get(gizmo) : null;
        if (scope.kind === "unassigned" && projectName) continue;
        records.set(item.id, catalogRecord(item, projectName));
      }
      offset += items.length;
      onProgress({ phase: "active", index: offset, total: Number.isFinite(data.total) ? data.total : null });
      const hasNext = data.has_next ?? data.has_more;
      if (hasNext === false || (hasNext !== true && items.length < PAGE_SIZE)) break;
    }
  }
  const catalog = buildCatalog({ projects, now, conversations: [...records.values()] });
  catalog.projects = projects.map((project) => {
    const info = known.get(project.projectName) || { count: null, samples: [] };
    return { projectName: project.projectName, conversationCount: info.count, sampleTitles: info.samples };
  }).sort((left, right) => left.projectName.localeCompare(right.projectName));
  catalog.scope = { ...catalog.scope, complete: false, collected: scope };
  return catalog;
}

function buildCatalog({ projects, conversations, now = () => new Date() }) {
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
      complete: true,
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
