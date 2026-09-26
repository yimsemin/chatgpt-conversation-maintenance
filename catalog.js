// 대화 카탈로그 수집. 범위(scope)에 따라 두 가지다.
// - 전체 수집(collectConversationCatalog): 프로젝트를 순회하며 모든 활성·보관 대화를 읽는다. 완전하다.
// - 범위 수집(collectScopedCatalog): 고른 범위의 활성 대화만 읽는다(프로젝트 범위는 그 프로젝트만, 나머지는 목록 기준).
// 전체 대화 목록 응답에는 프로젝트 대화가 일부 빠져 있어(2026-09-25 실측, API_COMPATIBILITY.md) 목록만으로는 프로젝트 안의 대화를 다 못 찾는다.
// 프로젝트 없는 대화는 그 실측에서 빠진 적이 없어 목록으로 찾는다.
import { assert } from "./assert.js";
import { CONVERSATION_ID } from "./ids.js";

const PAGE_SIZE = 100;
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

function unwrap(response, label) {
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

// 소유 프로젝트(ID·이름, 알면 마지막 수정 시각)를 모두 찾는다. 프로젝트를 찾는 유일한 구현이다(카탈로그와 프로젝트 배치가 함께 쓴다).
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
      const updated = timeMilliseconds(gizmo.updated_at ?? gizmo.updatedAt ?? entry?.updated_at ?? entry?.updatedAt ?? null);
      projects.push({
        projectId,
        projectName: gizmo.display?.name || gizmo.name || projectId,
        ...(updated !== null ? { updatedAt: new Date(updated).toISOString() } : {}),
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

// 소유한 프로젝트 목록(요청 1~2회): 이름과, 알 수 있으면 마지막 수정 시각. ChatGPT가 주는 순서를 그대로 둔다.
export async function listProjectsWithRecency(api) {
  return (await discoverProjects(api)).map((project) => ({ name: project.projectName, id: project.projectId,
    ...(project.updatedAt ? { updatedAt: project.updatedAt } : {}) }));
}

// 대화 목록(활성 또는 보관)을 페이지 단위로 돌려준다. offset 으로 넘기며, 같은 페이지가 반복되면 멈춘 것으로 보고 실패한다.
async function* listConversationPages(api, { archived, onProgress }) {
  let offset = 0;
  const seenPages = new Set();
  while (true) {
    const data = unwrap(
      await api.listConversations({ archived, offset, limit: PAGE_SIZE }),
      `${archived ? "Archived" : "Active"} conversation discovery`);
    const items = data.items || [];
    if (!items.length) return;
    const pageKey = `${items[0]?.id || ""}:${items.at(-1)?.id || ""}:${items.length}`;
    assert(!seenPages.has(pageKey), `Conversation pagination stalled at offset ${offset}`);
    seenPages.add(pageKey);
    yield items.filter((item) => CONVERSATION_ID.test(item.id || ""));
    offset += items.length;
    const total = Number.isFinite(data.total) ? data.total : null;
    onProgress({ phase: archived ? "archived" : "active", index: offset, total });
    const hasNext = data.has_next ?? data.has_more;
    if (hasNext === false) return;
    if (hasNext !== true && total !== null && offset >= total) return;
    if (hasNext !== true && total === null && items.length < PAGE_SIZE) return;
  }
}

export async function collectConversationCatalog(api, now = () => new Date(), onProgress = () => {}) {
  assert(api?.listProjectSidebar && api?.listProjectConversations && api?.listConversations,
    "Catalog API adapter is incomplete");
  onProgress({ phase: "projects", index: 0, total: null });
  const projects = await discoverProjects(api);

  const records = new Map();
  for (const [projectIndex, project] of projects.entries()) {
    onProgress({ phase: "projects", index: projectIndex, total: projects.length, projectName: project.projectName });
    for (const item of await readProjectConversations(api, project)) records.set(item.id, catalogRecord(item, project.projectName));
  }
  // 전체 목록은 프로젝트 대화를 일부 빠뜨리므로(위 설명) 프로젝트를 순회한 결과가 정본이고, 목록은 프로젝트 없는 대화와 보관 상태를 채운다.
  for (const archived of [false, true]) {
    for await (const items of listConversationPages(api, { archived, onProgress })) {
      for (const item of items) {
        const known = records.get(item.id);
        records.set(item.id, catalogRecord({ ...item, is_archived: item.is_archived === true || archived }, known?.projectName ?? null));
      }
    }
  }
  return buildCatalog({ projects, now, conversations: [...records.values()] });
}

const SAMPLE_PAGE_SIZE = 10;

// 읽은 대화 중 가장 최근 수정 시각(ISO). 프로젝트가 마지막으로 쓰인 때를 가늠하는 데 쓴다.
function latestOf(items) {
  let best = null;
  for (const item of items) {
    const ms = timeMilliseconds(item.update_time);
    if (ms !== null && (best === null || ms > best)) best = ms;
  }
  return best === null ? null : new Date(best).toISOString();
}

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

// 범위 수집. scope.kind: "project"(projectNames) | "unassigned" | "recent"(days). 완전 수집은 collectConversationCatalog 다.
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
    for (const [index, name] of scope.projectNames.entries()) {
      const target = projects.find((project) => project.projectName === name);
      assert(target, `프로젝트를 찾을 수 없습니다: ${name}`);
      onProgress({ phase: "projects", index, total: scope.projectNames.length, projectName: target.projectName });
      const items = await readProjectConversations(api, target);
      for (const item of items) records.set(item.id, catalogRecord(item, target.projectName));
      known.set(target.projectName, { count: items.length, samples: items.slice(0, 5).map((item) => item.title).filter(Boolean),
        latestUpdate: latestOf(items) });
    }
  } else {
    // 다른 프로젝트로 옮길 후보를 고르는 데 쓰이도록 프로젝트마다 표본 제목만 읽는다.
    for (const [index, project] of projects.entries()) {
      onProgress({ phase: "projects", index, total: projects.length, projectName: project.projectName });
      const items = await readProjectConversations(api, project, { onlyFirstPage: true });
      known.set(project.projectName, { count: null, samples: items.slice(0, 5).map((item) => item.title).filter(Boolean),
        latestUpdate: latestOf(items) });
    }
    const cutoff = scope.kind === "recent" ? now().getTime() - scope.days * 86400000 : null;
    listing: for await (const items of listConversationPages(api, { archived: false, onProgress })) {
      for (const item of items) {
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
    }
  }
  const catalog = buildCatalog({ projects, now, conversations: [...records.values()] });
  catalog.projects = projects.map((project) => {
    const info = known.get(project.projectName) || { count: null, samples: [] };
    return { projectName: project.projectName, conversationCount: info.count, sampleTitles: info.samples,
      ...(info.latestUpdate ? { latestUpdate: info.latestUpdate } : {}) };
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
