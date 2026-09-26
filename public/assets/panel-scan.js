// 확인 패널(조사 범위 선택)과 적용 대기 패널.
import { S, hooks } from "/assets/state.js";
import { ago, h } from "/assets/dom.js";
import { fail, post } from "/assets/net.js";
import { refreshSession } from "/assets/session-client.js";

// ---------- step 1: scan ----------
const SCOPE_KINDS = [["unassigned", "프로젝트에 넣지 않은 대화"], ["project", "특정 프로젝트의 대화"], ["recent", "최근 며칠 안에 수정한 대화"],
  ["all", "모든 대화(전체 재정비 — 오래 걸림)"]];

function saveScope() { try { localStorage.setItem("app_scan_scope", JSON.stringify(S.scope)); } catch {} }

export function loadScope() {
  try { const saved = JSON.parse(localStorage.getItem("app_scan_scope") || "null"); if (saved?.kind) S.scope = { ...S.scope, ...saved }; } catch {}
  if (!SCOPE_KINDS.some(([value]) => value === S.scope.kind)) S.scope.kind = "unassigned";
}

const SCOPE_HINTS = {
  unassigned: "프로젝트에 넣지 않은 대화를 후보로 삼습니다. 프로젝트로 정돈하는 것이 이 도구의 핵심 용도입니다.",
  project: "고른 프로젝트 안의 대화만 후보로 삼습니다. 작업을 마무리한 프로젝트를 정돈할 때 씁니다. 가장 빠릅니다.",
  recent: "최근 며칠 안에 수정한 대화를 후보로 삼습니다. 프로젝트 안의 대화는 ChatGPT 목록에서 일부 빠질 수 있으니 빠짐없이 보려면 프로젝트 범위를 쓰세요.",
  all: "모든 대화(보관한 것 포함)의 본문을 받아 처음부터 다시 분류합니다. 수 분~수 시간 걸리고 끊기면 이어받습니다.",
};

// 조사 범위를 고른다. 후보는 고른 범위의 대화 전부이며 지난 확인과 비교하지 않는다.
function scopePicker() {
  const s = S.session;
  const kind = h("select", { onchange: (e) => { S.scope.kind = e.target.value; saveScope(); S.panelKey = ""; hooks.render(); } },
    ...SCOPE_KINDS.map(([value, label]) => h("option", { value, text: label })));
  kind.value = S.scope.kind;
  const names = s.knownProjects?.names || [];
  if (S.scope.kind === "project" && !names.includes(S.scope.projectName)) S.scope.projectName = names[0] || "";
  const project = h("select", { onchange: (e) => { S.scope.projectName = e.target.value; saveScope(); } },
    ...names.map((name) => h("option", { value: name, text: name })));
  project.value = S.scope.projectName;
  const days = h("input", { type: "number", min: "1", max: "3650", value: String(S.scope.days || 7), size: "4",
    onchange: (e) => { S.scope.days = Math.max(1, Math.min(3650, Math.floor(Number(e.target.value)) || 7)); saveScope(); } });
  return h("div", {},
    h("div", { class: "row" }, h("label", { class: "field" }, "조사 범위 ", kind),
      S.scope.kind === "project" ? h("label", { class: "field" }, "프로젝트 ", project,
        h("button", { class: "btn ghost", type: "button", disabled: !s.relay?.connected, onclick: startProjectList }, names.length ? "목록 새로 읽기" : "프로젝트 목록 읽기")) : null,
      S.scope.kind === "recent" ? h("label", { class: "field" }, "최근 ", days, " 일") : null),
    h("p", { class: "muted small", text: SCOPE_HINTS[S.scope.kind] }));
}

export function scanBody() {
  const { kind, projectName, days } = S.scope;
  if (kind === "project") return { scope: { kind, projectName } };
  if (kind === "recent") return { scope: { kind, days } };
  return { scope: { kind } };
}

// 삭제후보 프로젝트에 옮겨 둔 대화 현황.
function trashCallout() {
  const trash = S.session.trash;
  if (!trash?.count) return null;
  return h("div", { class: "callout" },
    h("strong", { text: `삭제후보 ${trash.count}건` }), ` — ChatGPT의 `, h("b", { text: `「${trash.project}」` }),
    ` 프로젝트에 옮겨 두었습니다${trash.oldestDays ? `(가장 오래된 것은 ${trash.oldestDays}일 전)` : ""}. 직접 확인해 지우거나 살리세요. `,
    h("button", { class: "btn ghost", type: "button", onclick: () => { S.view = "trash"; S.panelKey = ""; hooks.render(); } }, "삭제후보 확인"));
}

export function scanPanel() {
  const s = S.session;
  const last = s.run?.phase === "complete" && s.run.candidates === 0 && !s.run.hasReport ? s.run : null;
  return h("div", {},
    h("h2", { text: "1. 대화 확인" }),
    h("p", { class: "muted", text: "정리할 범위를 고르고 ‘이 범위 확인’을 누르세요. 그 범위의 대화를 후보로 삼습니다. ChatGPT는 바꾸지 않고 읽기만 합니다." }),
    scopePicker(),
    last ? h("p", { class: "chip good", text: `이 범위에는 정리할 대화가 없습니다 · ${ago(last.updatedAt)} 확인` }) : null,
    !s.relay?.connected ? h("p", { class: "muted small", text: `${s.relay?.hint || ""} 연결되면 위의 ‘이 범위 확인’ 버튼이 켜집니다.` }) : null,
    trashCallout());
}

// 이미 검토가 끝난 결정(후속 실행 등)을 적용한다. 서버가 도중에 멈춰도 같은 버튼으로 이어진다.
export function applyReadyPanel() {
  return h("div", {}, h("h2", { text: "적용 대기" }),
    h("p", { class: "muted", text: "검토가 끝난 결정이 있습니다. 적용을 시작하면 끝날 때까지 자동으로 이어집니다." }),
    h("div", { class: "row" }, h("button", { class: "btn", type: "button", disabled: !S.session?.relay?.connected, onclick: async () => {
      try { await post("/maintenance/apply", { confirmDeletes: true }); await refreshSession(); } catch (e) { fail(e); }
    } }, "적용 시작")));
}

export async function startScan() {
  if (S.scope.kind === "all" && !confirm("모든 대화 본문을 받습니다(수백 건, 수 분~수 시간). ChatGPT는 바뀌지 않으며 끊기면 이어받습니다. 시작할까요?")) return;
  try { S.forceStep = null; await post("/maintenance/scan", scanBody()); await refreshSession(); } catch (e) { fail(e); }
}

async function startProjectList() {
  try { await post("/maintenance/projects"); await refreshSession(); } catch (e) { fail(e); }
}

// 삭제후보 프로젝트의 지금 대화를 읽어, 직접 지우거나 옮긴 대화를 목록에서 뺀다(읽기 전용).
export async function startTrashSync() {
  try { await post("/maintenance/trash/sync"); await refreshSession(); } catch (e) { fail(e); }
}
