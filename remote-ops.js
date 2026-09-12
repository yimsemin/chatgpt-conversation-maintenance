// 실제 ChatGPT 대화 ID 는 RFC 4122 의 버전 1~5 가 아니다. 예: 6aa3d0e3-2eac-83e9-...
// 의 버전 니블은 8 이다. 버전·variant 를 제한하면 실제 ID 가 전부 거부된다(2026-09-12 실측).
// 경로 주입을 막는 데는 8-4-4-4-12 16진수 형태만으로 충분하고, 이는 management.js 와 같다.
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PROJECT_ID = /^g-p-[0-9a-f]{32}$/;

const OPS = new Set([
  "accountInfo",
  "getConversation",
  "listConversations",
  "listProjects",
  "listProjectConversations",
  "createProject",
  "moveConversation",
  "patchConversation",
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(JSON.stringify(actual) === JSON.stringify(wanted), `${label} contains unsupported fields`);
}

function integer(value, label, min, max) {
  assert(Number.isInteger(value) && value >= min && value <= max, `${label} is invalid`);
}

export function validateRemoteOperation(input) {
  exactKeys(input, ["op", "params"], "Remote operation");
  assert(OPS.has(input.op), `Unsupported remote operation: ${input.op || "<missing>"}`);
  const params = input.params;
  assert(params && typeof params === "object" && !Array.isArray(params), "params must be an object");

  if (input.op === "accountInfo") exactKeys(params, [], "accountInfo params");
  if (input.op === "getConversation") {
    exactKeys(params, ["id"], "getConversation params");
    assert(CONVERSATION_ID.test(params.id || ""), "Conversation ID is invalid");
  }
  if (input.op === "listConversations") {
    exactKeys(params, ["archived", "offset", "limit"], "listConversations params");
    assert(typeof params.archived === "boolean", "archived must be boolean");
    integer(params.offset, "offset", 0, 1000000);
    integer(params.limit, "limit", 1, 100);
  }
  if (input.op === "listProjects") {
    exactKeys(params, ["cursor", "limit"], "listProjects params");
    assert(typeof params.cursor === "string" && params.cursor.length <= 1000, "cursor is invalid");
    integer(params.limit, "limit", 1, 100);
  }
  if (input.op === "listProjectConversations") {
    exactKeys(params, ["projectId", "cursor", "limit"], "listProjectConversations params");
    assert(PROJECT_ID.test(params.projectId || ""), "Project ID is invalid");
    assert(typeof params.cursor === "string" && params.cursor.length <= 1000, "cursor is invalid");
    integer(params.limit, "limit", 1, 100);
  }
  if (input.op === "createProject") {
    exactKeys(params, ["name", "instructions"], "createProject params");
    assert(typeof params.name === "string" && params.name === params.name.trim()
      && params.name.length >= 1 && params.name.length <= 100, "Project name is invalid");
    assert(typeof params.instructions === "string" && params.instructions.length <= 8000,
      "Project instructions are invalid");
  }
  if (input.op === "moveConversation") {
    exactKeys(params, ["id", "projectId"], "moveConversation params");
    assert(CONVERSATION_ID.test(params.id || ""), "Conversation ID is invalid");
    assert(PROJECT_ID.test(params.projectId || ""), "Project ID is invalid");
  }
  if (input.op === "patchConversation") {
    exactKeys(params, ["id", "body"], "patchConversation params");
    assert(CONVERSATION_ID.test(params.id || ""), "Conversation ID is invalid");
    assert(params.body && typeof params.body === "object" && !Array.isArray(params.body), "Patch body is invalid");
    const keys = Object.keys(params.body);
    assert(keys.length === 1 && ["title", "is_archived", "is_visible"].includes(keys[0]),
      "Patch body must contain exactly one supported field");
    if (keys[0] === "title") assert(typeof params.body.title === "string" && params.body.title.length <= 256,
      "Conversation title is invalid");
    else assert(typeof params.body[keys[0]] === "boolean", `${keys[0]} must be boolean`);
  }
  return { op: input.op, params: structuredClone(params) };
}

// 페이지 실행기의 독립 op→URL 표와 계약이 어긋나지 않는지 Node 테스트에서 확인한다.
// 런타임 HTTP에는 쓰지 않으며 절대 URL을 받거나 반환하지 않는다.
export function describeRemoteRequest(input) {
  const { op, params: p } = validateRemoteOperation(input);
  if (op === "accountInfo") return { method: "GET", path: "/api/auth/session", body: null };
  if (op === "getConversation") return { method: "GET", path: `/backend-api/conversation/${encodeURIComponent(p.id)}`, body: null };
  if (op === "listConversations") {
    const query = new URLSearchParams({ offset: String(p.offset), limit: String(p.limit), is_archived: String(p.archived) });
    return { method: "GET", path: `/backend-api/conversations?${query}`, body: null };
  }
  if (op === "listProjects") {
    const query = new URLSearchParams({ owned_only: "true", conversations_per_gizmo: "0", limit: String(p.limit) });
    if (p.cursor) query.set("cursor", p.cursor);
    return { method: "GET", path: `/backend-api/gizmos/snorlax/sidebar?${query}`, body: null };
  }
  if (op === "listProjectConversations") {
    const query = new URLSearchParams({ limit: String(p.limit) });
    if (p.cursor) query.set("cursor", p.cursor);
    return { method: "GET", path: `/backend-api/gizmos/${encodeURIComponent(p.projectId)}/conversations?${query}`, body: null };
  }
  if (op === "createProject") return { method: "POST", path: "/backend-api/projects", body: { name: p.name, instructions: p.instructions } };
  if (op === "moveConversation") return { method: "PATCH", path: `/backend-api/conversation/${encodeURIComponent(p.id)}`, body: { gizmo_id: p.projectId } };
  return { method: "PATCH", path: `/backend-api/conversation/${encodeURIComponent(p.id)}`, body: structuredClone(p.body) };
}

export function validateRemoteResult(input, operation = null) {
  exactKeys(input, ["ok", "status", "data", "contentType", ...(input.bodySnippet === undefined ? [] : ["bodySnippet"])],
    "Remote result");
  assert(typeof input.ok === "boolean", "Remote result ok must be boolean");
  integer(input.status, "Remote result status", 100, 599);
  assert(input.data === null || typeof input.data === "object", "Remote result data must be JSON or null");
  assert(typeof input.contentType === "string" && input.contentType.length <= 200, "Remote content type is invalid");
  if (input.bodySnippet !== undefined) {
    assert(!input.ok, "Successful remote results cannot include body snippets");
    assert(typeof input.bodySnippet === "string" && input.bodySnippet.length <= 200, "Remote body snippet is invalid");
  }
  if (input.ok) {
    assert(input.data && typeof input.data === "object" && !Array.isArray(input.data),
      "Successful remote result must contain a JSON object");
    if (operation?.op === "accountInfo") {
      assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.data.accountId || ""),
        "Account response is invalid");
    }
    if (operation?.op === "getConversation") {
      const id = input.data.conversation_id || input.data.id;
      assert(id === operation.params.id, "Conversation response ID does not match the request");
    }
  }
  return structuredClone(input);
}
