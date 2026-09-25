// 모의 ChatGPT 계정. chatgpt.com 페이지 실행기가 수행하는 원격 op 계약(remote-ops.js)을 메모리에서
// 흉내 내고, 429·무응답·지연 같은 실패를 주입해 실계정 없이 흐름 전체를 시험한다.
import { randomUUID } from "node:crypto";

const JSON_TYPE = "application/json";
const ACCOUNT = "11111111-2222-4333-8444-555555555555";

function ok(data) { return { ok: true, status: 200, data, contentType: JSON_TYPE }; }
function fail(status, snippet = "") {
  return { ok: false, status, data: null, contentType: JSON_TYPE, ...(snippet ? { bodySnippet: snippet } : {}) };
}

export function fakeConversationId(n) {
  return `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export function fakeProjectId(n) {
  return `g-p-${String(n).padStart(32, "0")}`;
}

export function createFakeChatGPT({ conversations = [], projects = [], accountId = ACCOUNT, clock = null } = {}) {
  let tick = 1_800_000_000;
  const time = clock || (() => (tick += 1));
  const convs = new Map();
  const projs = new Map();
  for (const item of conversations) {
    convs.set(item.id, {
      title: "제목 — 결과", gizmo_id: null, is_archived: false, is_visible: true,
      create_time: 1_700_000_000, update_time: time(), ...item,
    });
  }
  for (const item of projects) projs.set(item.id, { ...item });
  const stats = { calls: 0, byOp: {}, injected: 0 };
  const injections = [];
  let latencyMs = 0;

  function touch(conv) { conv.update_time = time(); }
  function summary(conv) {
    return { id: conv.id, title: conv.title, create_time: conv.create_time, update_time: conv.update_time,
      is_archived: conv.is_archived, gizmo_id: conv.gizmo_id };
  }
  function detail(conv) {
    return {
      conversation_id: conv.id, id: conv.id, title: conv.title, create_time: conv.create_time,
      update_time: conv.update_time, is_archived: conv.is_archived, is_visible: conv.is_visible,
      gizmo_id: conv.gizmo_id, conversation_template_id: conv.gizmo_id, current_node: "n1",
      mapping: {
        root: { id: "root", parent: null, message: null },
        n1: { id: "n1", parent: "root", message: { author: { role: "user" }, content: { parts: ["hello"] }, metadata: {} } },
      },
    };
  }
  const visible = () => [...convs.values()].filter((conv) => conv.is_visible);
  const byRecent = (list) => list.sort((a, b) => b.update_time - a.update_time || a.id.localeCompare(b.id));

  const ops = {
    accountInfo: () => ok({ accountId }),
    getConversation: ({ id }) => {
      const conv = convs.get(id);
      return conv && conv.is_visible ? ok(detail(conv)) : fail(404, "not found");
    },
    listConversations: ({ archived, offset, limit }) => {
      const list = byRecent(visible().filter((conv) => conv.is_archived === archived));
      const items = list.slice(offset, offset + limit).map(summary);
      return ok({ items, total: list.length, has_next: offset + items.length < list.length });
    },
    listProjects: ({ cursor, limit }) => {
      const list = [...projs.values()];
      const start = cursor ? Number(cursor) : 0;
      const items = list.slice(start, start + limit)
        .map((project) => ({ resource: { gizmo: { id: project.id, display: { name: project.name } } } }));
      const next = start + items.length < list.length ? String(start + items.length) : null;
      return ok({ list: { items, cursor: next } });
    },
    listProjectConversations: ({ projectId, cursor, limit }) => {
      if (!projs.has(projectId)) return fail(404, "project not found");
      const list = byRecent(visible().filter((conv) => conv.gizmo_id === projectId));
      const start = cursor ? Number(cursor) : 0;
      const items = list.slice(start, start + limit).map(summary);
      const next = start + items.length < list.length ? String(start + items.length) : null;
      return ok({ items, cursor: next });
    },
    createProject: ({ name }) => {
      const id = fakeProjectId(projs.size + 1 + 1000);
      projs.set(id, { id, name });
      return ok({ project: { id } });
    },
    moveConversation: ({ id, projectId }) => {
      const conv = convs.get(id);
      if (!conv || !conv.is_visible) return fail(404, "not found");
      if (!projs.has(projectId)) return fail(404, "project not found");
      conv.gizmo_id = projectId;
      touch(conv);
      return ok({ success: true });
    },
    patchConversation: ({ id, body }) => {
      const conv = convs.get(id);
      if (!conv || !conv.is_visible) return fail(404, "not found");
      if ("title" in body) conv.title = body.title;
      if ("is_archived" in body) conv.is_archived = body.is_archived;
      if ("is_visible" in body) conv.is_visible = body.is_visible;
      touch(conv);
      return ok({ success: true });
    },
  };

  return {
    accountId,
    stats,
    conversations: convs,
    projects: projs,
    setLatency(ms) { latencyMs = ms; },
    // 다음 times 번의 op 호출을 상태 코드로 실패시킨다. op 를 생략하면 모든 op.
    inject({ op = null, status = 429, times = 1 }) { injections.push({ op, status, times, hang: false }); },
    // 다음 times 번의 호출에 응답하지 않는다(페이지 무응답).
    hang({ op = null, times = 1 }) { injections.push({ op, status: 0, times, hang: true }); },
    addConversation(item) {
      const id = item.id || fakeConversationId(convs.size + 1);
      convs.set(id, { title: "제목 — 결과", gizmo_id: null, is_archived: false, is_visible: true,
        create_time: time(), update_time: time(), ...item, id });
      return id;
    },
    // 브로커 요청 하나를 처리한다. 무응답 주입이면 undefined 를 돌려준다(응답하지 않음).
    async handle(request) {
      stats.calls += 1;
      stats.byOp[request.op] = (stats.byOp[request.op] || 0) + 1;
      if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs));
      const injection = injections.find((item) => item.times > 0 && (!item.op || item.op === request.op));
      if (injection) {
        injection.times -= 1;
        stats.injected += 1;
        return injection.hang ? undefined : fail(injection.status, "injected");
      }
      return ops[request.op](request.params);
    },
    newId() { return randomUUID(); },
  };
}

// 유지관리 창 + 페이지 실행기 역할. 브로커에서 요청을 꺼내 모의 계정에 전달하고 결과를 돌려준다.
export function attachFakePage(broker, fake, { clientId = randomUUID(), pollMs = 5 } = {}) {
  let running = true;
  broker.connect(clientId);
  const loop = (async () => {
    while (running) {
      let next;
      try { next = broker.next(clientId); } catch { break; }
      if (!next.request) { await new Promise((resolve) => setTimeout(resolve, pollMs)); continue; }
      const { id, op, params } = next.request;
      const result = await fake.handle({ op, params });
      if (result === undefined) continue;
      try { broker.complete(clientId, id, result); } catch {}
    }
  })();
  return { clientId, async stop() { running = false; await loop; } };
}
