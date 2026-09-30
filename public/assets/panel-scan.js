// 확인 패널(조사 범위 선택)과 적용 대기 패널.
import { S, hooks } from "/assets/state.js";
import { ago, h } from "/assets/dom.js";
import { fail, post, toast } from "/assets/net.js";
import { projectIdFromLink } from "/assets/shared/project-link.js";
import { refreshSession } from "/assets/session-client.js";

// ---------- step 1: scan ----------
const SCOPE_KINDS = [["unassigned", "프로젝트에 넣지 않은 대화"], ["project", "특정 프로젝트의 대화"], ["recent", "최근 며칠 안에 수정한 대화"], ["untidy", "아직 정돈되지 않은 대화(표준 제목 전까지)"],
  ["all", "모든 대화(전체 재정비 — 오래 걸림)"]];

// 프로젝트 없는 대화의 기간 선택지(일). 0 은 기간 제한 없음.
const UNASSIGNED_WINDOWS = [[14, "최근 14일"], [30, "최근 30일"], [0, "전체 기간"]];

// 받지 못하는 대화를 4회 실패 시 건너뛸지(기본 켬). 끄면 전부 받을 때까지 멈추고 재시도한다.
function skipFailedOn() { try { return localStorage.getItem("app_skip_failed") !== "0"; } catch { return true; } }

function skipStandardOn() { try { return localStorage.getItem("app_skip_standard") === "1"; } catch { return false; } }

function saveScope() { try { localStorage.setItem("app_scan_scope", JSON.stringify(S.scope)); } catch {} }

export function loadScope() {
  try {
    const saved = JSON.parse(localStorage.getItem("app_scan_scope") || "null");
    if (saved?.kind) S.scope = { ...S.scope, ...saved, projectNames: Array.isArray(saved.projectNames) ? saved.projectNames : (saved.projectName ? [saved.projectName] : []) };
  } catch {}
  if (!SCOPE_KINDS.some(([value]) => value === S.scope.kind)) S.scope.kind = "unassigned";
  if (!UNASSIGNED_WINDOWS.some(([value]) => value === S.scope.window)) S.scope.window = 14;
}

const SCOPE_HINTS = {
  unassigned: "프로젝트에 넣지 않은 대화를 후보로 삼습니다. 프로젝트로 정돈하는 것이 이 도구의 핵심 용도입니다. 프로젝트 목록은 읽지 않으며, 옮길 프로젝트는 이전에 쓴 프로젝트 중에서 고릅니다. 기간을 좁히면 목록을 덜 읽어 빨라집니다.",
  project: "고른 프로젝트 안의 대화만 후보로 삼습니다. 작업을 마무리한 프로젝트를 정돈할 때 씁니다. 가장 빠릅니다.",
  recent: "최근 며칠 안에 수정한 대화를 후보로 삼습니다. 프로젝트 안의 대화는 ChatGPT 목록에서 일부 빠질 수 있으니 빠짐없이 보려면 프로젝트 범위를 쓰세요.",
  untidy: "수정 시각이 최신인 대화부터 읽다가, 표준 제목(‘주제 — 작업’)의 대화가 3건 연달아 나오면 이미 정돈된 구간으로 보고 멈춥니다. 새로 생기거나 바뀐 대화만 정리할 때 가장 빠릅니다. 제목만 표준이고 프로젝트가 틀린 대화는 찾지 못하니 그런 경우는 다른 범위를 쓰세요.",
  all: "모든 대화(보관한 것 포함)의 본문을 받아 처음부터 다시 분류합니다. 수 분~수 시간 걸리고 끊기면 이어받습니다.",
};

// 프로젝트가 마지막으로 쓰인 때를 사람이 읽는 말로(알 때만).
function since(iso) {
  const ms = Date.parse(iso || ""); if (!Number.isFinite(ms)) return "";
  const days = Math.floor((Date.now() - ms) / 86400000);
  return days <= 0 ? "오늘" : `${days}일 전`;
}

// 조사 범위를 고른다. 후보는 고른 범위의 대화 전부이며 지난 확인과 비교하지 않는다.
function scopePicker() {
  const s = S.session;
  const kind = h("select", { onchange: (e) => { S.scope.kind = e.target.value; saveScope(); S.panelKey = ""; hooks.render(); } },
    ...SCOPE_KINDS.map(([value, label]) => h("option", { value, text: label })));
  kind.value = S.scope.kind;
  const days = h("input", { type: "number", min: "1", max: "3650", value: String(S.scope.days || 7), size: "4",
    onchange: (e) => { S.scope.days = Math.max(1, Math.min(3650, Math.floor(Number(e.target.value)) || 7)); saveScope(); } });
  // 프로젝트 없는 대화는 기간을 좁힐 수 있다(기본 14일). 기간이 짧을수록 대화 목록을 덜 읽는다.
  const period = h("select", { onchange: (e) => { S.scope.window = Number(e.target.value); saveScope(); } },
    ...UNASSIGNED_WINDOWS.map(([value, label]) => h("option", { value: String(value), text: label })));
  period.value = String(S.scope.window);
  // 한 줄: 범위 선택 + (프로젝트 없는 대화면 기간, 최근 N일이면 일수 입력)
  const line = h("div", { class: "row" }, h("label", { class: "field inline" }, "조사 범위", kind),
    S.scope.kind === "unassigned" ? h("label", { class: "field inline" }, "기간", period) : null,
    S.scope.kind === "recent" ? h("label", { class: "field inline" }, "최근", days, "일") : null);
  return h("div", {}, line, S.scope.kind === "project" ? projectChooser() : null, h("p", { class: "muted small", text: SCOPE_HINTS[S.scope.kind] }));
}

// 프로젝트를 여러 개 고른다. 최근에 쓴 프로젝트가 앞에 온다(수정 시각을 알 수 있으면 그 순서, 아니면 ChatGPT 목록 순서).
function projectChooser() {
  const s = S.session;
  const projects = s.knownProjects?.projects || [];
  const chosen = new Set(S.scope.projectNames);
  const count = h("span", { class: "muted small", text: `선택 ${chosen.size}개` });
  const items = projects.map((project) => {
    const box = h("input", { type: "checkbox", checked: chosen.has(project.name) ? true : null, onchange: (e) => {
      if (e.target.checked) chosen.add(project.name); else chosen.delete(project.name);
      S.scope.projectNames = projects.map((p) => p.name).filter((name) => chosen.has(name));
      count.textContent = `선택 ${chosen.size}개`; saveScope();
    } });
    return h("label", { class: "check project-item" }, box, project.name, project.updatedAt ? h("span", { class: "muted small", text: ` · ${since(project.updatedAt)}` }) : null);
  });
  // 프로젝트 링크(ChatGPT에서 프로젝트를 열었을 때 주소창 주소)를 붙여 넣으면 그 프로젝트를 고른다.
  const link = h("input", { type: "text", size: "34", placeholder: "프로젝트 링크 붙여넣기", onchange: (e) => {
    const id = projectIdFromLink(e.target.value); e.target.value = "";
    const project = id ? projects.find((p) => p.id === id) : null;
    if (!id) { toast("프로젝트 링크가 아닙니다", "ChatGPT에서 프로젝트를 연 주소(…/g/g-p-…/project)를 붙여 넣어 주세요."); return; }
    if (!project) { toast("목록에 없는 프로젝트입니다", "‘프로젝트 목록 새로 읽기’를 누른 뒤 다시 붙여 넣어 보세요."); return; }
    if (!chosen.has(project.name)) { chosen.add(project.name); S.scope.projectNames = projects.map((p) => p.name).filter((name) => chosen.has(name)); saveScope(); }
    toast("프로젝트를 골랐습니다", project.name); S.panelKey = ""; hooks.render();
  } });
  return h("div", {},
    h("div", { class: "row" }, count, link,
      h("button", { class: "btn ghost", type: "button", disabled: !s.relay?.connected, onclick: startProjectList }, projects.length ? "프로젝트 목록 새로 읽기" : "프로젝트 목록 읽기")),
    projects.length ? h("div", { class: "project-list" }, items) : h("p", { class: "muted small", text: "먼저 ‘프로젝트 목록 읽기’를 누르세요(요청 몇 번, 몇 초 걸립니다). 한 번 읽으면 저장해 두고 이후에는 다시 읽지 않아도 됩니다." }));
}

// 실행(run)에 기록된 조사 범위를 사람이 읽는 말로.
export function scopeLabel(scope) {
  if (!scope) return "";
  if (scope.kind === "project") return `프로젝트 ${(scope.projectNames || (scope.projectName ? [scope.projectName] : [])).map((name) => `「${name}」`).join(", ")}`;
  if (scope.kind === "recent") return `최근 ${scope.days}일`;
  if (scope.kind === "untidy") return "아직 정돈되지 않은 대화";
  if (scope.kind === "all") return "모든 대화";
  return scope.days ? `프로젝트에 넣지 않은 대화(최근 ${scope.days}일)` : "프로젝트에 넣지 않은 대화";
}

// 진행 중인 분류·검토가 있으면 새 확인을 시작할 때 버려진다는 것을 알린다.
function pendingRun() {
  const run = S.session?.run;
  return run && run.phase !== "complete" ? run : null;
}

function scanBody() {
  const { kind, projectNames, days, window } = S.scope;
  const skipFailed = skipFailedOn();
  const skipStandardTitles = skipStandardOn();
  if (kind === "project") return { scope: { kind, projectNames }, skipFailed, skipStandardTitles };
  if (kind === "recent") return { scope: { kind, days }, skipFailed, skipStandardTitles };
  if (kind === "unassigned") return { scope: window ? { kind, days: window } : { kind }, skipFailed, skipStandardTitles };
  return { scope: { kind }, skipFailed, skipStandardTitles };
}

// 받지 못해 건너뛴 대화 안내. 후보에서 빠졌으므로 나중에 같은 범위로 다시 확인하면 다시 시도한다.
export function skippedCallout(skipped) {
  return h("div", { class: "callout" }, h("strong", { text: `받지 못해 건너뛴 대화 ${skipped.length}건` }),
    " — 4회 시도해도 ChatGPT에서 받아지지 않아 이번 후보에서 뺐습니다. ChatGPT 웹에서 그 대화가 열리는지 확인해 보고, 나중에 같은 범위로 다시 확인하면 다시 시도합니다.",
    h("ul", {}, ...skipped.slice(0, 20).map((item) => h("li", { text: `${item.title}${item.status ? ` (HTTP ${item.status})` : ""}` })),
      skipped.length > 20 ? h("li", { text: `…외 ${skipped.length - 20}건` }) : null));
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
  const pending = pendingRun();
  return h("div", {},
    h("h2", { text: "1. 대화 확인" }),
    pending ? h("div", { class: "callout" }, h("strong", { text: "진행 중인 정리가 있습니다" }),
      ` — ${scopeLabel(pending.scope)} 후보 ${pending.candidates ?? "?"}건이 분류·검토를 기다리고 있습니다. 아래에서 새로 확인을 시작하면 그 정리는 버려집니다(ChatGPT는 바뀌지 않습니다). `,
      h("button", { class: "btn ghost", type: "button", onclick: () => { S.forceStep = null; S.panelKey = ""; hooks.render(); } }, "그 정리로 돌아가기")) : null,
    s.partialScan ? h("div", { class: "callout" }, h("strong", { text: "끊긴 확인이 있습니다" }),
      ` — ${scopeLabel(s.partialScan.scope)} ${s.partialScan.total}건 중 ${s.partialScan.downloaded}건을 받아 두었습니다. 같은 범위로 ‘이 범위 확인’을 누르면 나머지만 이어서 받고, 지금까지 받은 것만으로 분류를 진행할 수도 있습니다(ChatGPT는 읽지 않습니다). `,
      h("button", { class: "btn ghost", type: "button", onclick: startPartialScan }, `받은 ${s.partialScan.downloaded}건으로 분류 진행`)) : null,
    s.discardedRun ? h("div", { class: "callout" }, h("strong", { text: "이전 방식으로 만든 정리는 쓸 수 없어 버렸습니다" }),
      ` — 예전 버전에서 시작한 정리(후보 ${s.discardedRun.candidates ?? "?"}건)는 지금의 조사 범위 방식과 맞지 않습니다. ChatGPT는 바뀌지 않았습니다. 아래에서 범위를 골라 새로 확인하세요.`) : null,
    h("p", { class: "muted", text: "정리할 범위를 고르고 ‘이 범위 확인’을 누르세요. 그 범위의 대화를 후보로 삼습니다. ChatGPT는 바꾸지 않고 읽기만 합니다." }),
    scopePicker(),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: skipFailedOn() ? true : null, onchange: (e) => { try { localStorage.setItem("app_skip_failed", e.target.checked ? "1" : "0"); } catch {} } }),
      " 받아지지 않는 대화는 4회 실패하면 건너뛰기(끄면 전부 받을 때까지 재시도하며, 안 열리는 대화가 있으면 거기서 멈춥니다)"),
    h("label", { class: "check" }, h("input", { type: "checkbox", checked: skipStandardOn() ? true : null, onchange: (e) => { try { localStorage.setItem("app_skip_standard", e.target.checked ? "1" : "0"); } catch {} } }),
      " 제목이 이미 표준 형식인 대화는 받지 않기(제목만 정리할 때 빠릅니다. 제목이 표준이어도 프로젝트가 틀린 대화는 찾지 못하니, 프로젝트 배치까지 볼 때는 끄세요)"),
    h("div", { class: "row" }, h("button", { class: "btn", type: "button", disabled: !s.relay?.connected, onclick: startScan }, "이 범위 확인")),
    last ? h("p", { class: "chip good", text: `이 범위에는 정리할 대화가 없습니다 · ${ago(last.updatedAt)} 확인` }) : null,
    last?.standardTitlesExcluded ? h("p", { class: "muted small", text: `표준 제목인 대화 ${last.standardTitlesExcluded}건은 받지 않았습니다.` }) : null,
    last?.skipped?.length ? skippedCallout(last.skipped) : null,
    !s.relay?.connected ? h("p", { class: "muted small", text: `${s.relay?.hint || ""} 연결되면 ‘이 범위 확인’ 버튼이 켜집니다.` }) : null,
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
  if (S.scope.kind === "project" && !S.scope.projectNames.length) { toast("프로젝트를 고르세요", "확인할 프로젝트를 하나 이상 골라 주세요."); return; }
  const pending = pendingRun();
  if (pending && !confirm(`진행 중인 정리(${scopeLabel(pending.scope)}, 후보 ${pending.candidates ?? "?"}건)는 현재 정리에서 내려지고 새로 확인합니다(그 정리 파일은 data/runs에 남습니다). ChatGPT는 바뀌지 않습니다. 계속할까요?`)) return;
  if (S.scope.kind === "all" && !confirm("모든 대화 본문을 받습니다(수백 건, 수 분~수 시간). ChatGPT는 바뀌지 않으며 끊기면 이어받습니다. 시작할까요?")) return;
  try { S.forceStep = null; await post("/maintenance/scan", scanBody()); await refreshSession(); } catch (e) { fail(e); }
}

async function startPartialScan() {
  const pending = pendingRun();
  if (pending && !confirm(`진행 중인 정리(${scopeLabel(pending.scope)}, 후보 ${pending.candidates ?? "?"}건)는 현재 정리에서 내려지고 받아 둔 대화로 새 정리가 시작됩니다. 계속할까요?`)) return;
  try { S.forceStep = null; await post("/maintenance/scan/partial"); await refreshSession(); } catch (e) { fail(e); }
}

async function startProjectList() {
  try { await post("/maintenance/projects"); await refreshSession(); } catch (e) { fail(e); }
}

// 삭제후보 프로젝트의 지금 대화를 읽어, 직접 지우거나 옮긴 대화를 목록에서 뺀다(읽기 전용).
export async function startTrashSync() {
  try { await post("/maintenance/trash/sync"); await refreshSession(); } catch (e) { fail(e); }
}
