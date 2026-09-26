// 사용자에게 보이는 요약: 적용 전 "무엇이 바뀌는가"와 적용 후 "무엇이 바뀌었고 내가 할 일은 무엇인가".
// 순수 함수만 둔다(파일·네트워크 없음). 입력은 카탈로그(기준 목록)와 대화별 결정 행이다.

export function rowsFromProposal(proposal, inventory) {
  const byId = new Map((inventory.conversations || []).map((item) => [item.conversationId, item]));
  return (proposal.items || []).map((item) => {
    const source = byId.get(item.conversationId) || {};
    return {
      conversationId: item.conversationId,
      title: item.currentTitle ?? source.title ?? "",
      currentProject: item.projectName ?? source.projectName ?? null,
      decision: item.suggestedDecision === "delete" ? "delete" : "keep",
      undecided: item.suggestedDecision === "undecided",
      newTitle: item.suggestedNewTitle || null,
      project: item.suggestedProjectName ?? null,
      confidence: item.confidence || null,
      why: item.rationale || "",
      action: item.suggestedProjectAction || null,
    };
  });
}

export function rowsFromDecisions(decisions, inventory) {
  const byId = new Map((inventory.conversations || []).map((item) => [item.conversationId, item]));
  return (decisions.decisions || []).map((item) => {
    const source = byId.get(item.conversationId) || {};
    return {
      conversationId: item.conversationId,
      title: source.title ?? "",
      currentProject: source.projectName ?? null,
      decision: item.decision === "delete" ? "delete" : "keep",
      undecided: false,
      trashed: item.trashed === true,
      marked: item.marked === true,
      newTitle: item.newTitle || null,
      project: item.decision === "delete" ? null : (item.projectName ?? null),
      confidence: null,
      why: item.rationale || "",
      action: null,
    };
  });
}

// 대화 수를 아는 프로젝트만 센다. 범위 조사로 읽은 카탈로그에서 읽지 않은 프로젝트(conversationCount 가 null)는 수를 알 수 없다.
function countByProject(catalog) {
  const counts = new Map();
  for (const project of catalog.projects || []) if (project.conversationCount !== null) counts.set(project.projectName, 0);
  for (const conversation of catalog.conversations || []) {
    if (conversation.projectName && counts.has(conversation.projectName)) {
      counts.set(conversation.projectName, counts.get(conversation.projectName) + 1);
    }
  }
  return counts;
}

const projectNames = (catalog) => new Set((catalog.projects || []).map((project) => project.projectName));

function classify(row) {
  const moving = row.decision === "keep" && row.project && row.project !== row.currentProject;
  const manualRemove = row.decision === "keep" && !row.project && Boolean(row.currentProject);
  const renaming = row.decision === "keep" && row.newTitle && row.newTitle !== row.title;
  return { moving: Boolean(moving), manualRemove, renaming: Boolean(renaming) };
}

export function buildReviewSummary({ catalog, rows }) {
  const before = countByProject(catalog);
  const after = new Map(before);
  // 수를 모르는 프로젝트는 변화량(delta)만 센다.
  const delta = new Map();
  const bump = (name, by) => {
    if (!name) return;
    // 이번에 새로 만드는 프로젝트는 0에서 시작하므로 수를 안다.
    if (!knownProjects.has(name) && !before.has(name)) { before.set(name, 0); after.set(name, 0); }
    delta.set(name, (delta.get(name) || 0) + by);
    if (before.has(name)) after.set(name, after.get(name) + by);
  };
  const knownProjects = projectNames(catalog);

  const totals = { candidates: rows.length, keep: 0, delete: 0, undecided: 0, trashed: 0, marked: 0 };
  const changes = { rename: 0, move: 0, remove: 0, trashed: 0, newProjects: [] };
  const exceptions = { deletes: [], lowConfidence: [], moves: [], renames: [], undecided: [], manualRemoves: [], trashed: [], marked: [] };
  const newProjects = new Set();

  for (const row of rows) {
    const { moving, manualRemove, renaming } = classify(row);
    const brief = { conversationId: row.conversationId, title: row.title, project: row.currentProject,
      why: row.why, confidence: row.confidence };
    if (row.undecided) { totals.undecided += 1; exceptions.undecided.push(brief); continue; }
    if (row.marked) {
      // 삭제 후보를 어느 프로젝트로도 옮기지 않고 표시만 하는 행. 사용자가 ChatGPT에서 직접 지운다.
      totals.marked += 1;
      exceptions.marked.push(brief);
      if (renaming) {
        changes.rename += 1;
        exceptions.renames.push({ conversationId: row.conversationId, from: row.title, to: row.newTitle });
      }
      continue;
    }
    if (row.trashed) {
      // 삭제 후보를 삭제후보 프로젝트로 옮기는 행. 삭제가 아니라 이동이며 사용자가 나중에 직접 확인한다.
      totals.trashed += 1;
      changes.trashed += 1;
      bump(row.currentProject, -1);
      bump(row.project, 1);
      if (!knownProjects.has(row.project)) newProjects.add(row.project);
      exceptions.trashed.push(brief);
      if (renaming) {
        changes.rename += 1;
        exceptions.renames.push({ conversationId: row.conversationId, from: row.title, to: row.newTitle });
      }
      continue;
    }
    if (row.decision === "delete") {
      totals.delete += 1;
      bump(row.currentProject, -1);
      exceptions.deletes.push(brief);
      continue;
    }
    totals.keep += 1;
    if (row.confidence === "low") exceptions.lowConfidence.push(brief);
    if (renaming) {
      changes.rename += 1;
      exceptions.renames.push({ conversationId: row.conversationId, from: row.title, to: row.newTitle });
    }
    if (moving) {
      changes.move += 1;
      bump(row.currentProject, -1);
      bump(row.project, 1);
      if (!knownProjects.has(row.project)) newProjects.add(row.project);
      exceptions.moves.push({ conversationId: row.conversationId, title: row.newTitle || row.title,
        from: row.currentProject, to: row.project });
    }
    if (manualRemove) {
      changes.remove += 1;
      exceptions.manualRemoves.push({ conversationId: row.conversationId, title: row.title, project: row.currentProject });
    }
  }
  changes.newProjects = [...newProjects].sort();

  const names = new Set([...before.keys(), ...delta.keys()]);
  const projects = [...names].map((name) => ({
    name,
    before: before.has(name) ? before.get(name) : null,
    after: after.has(name) ? after.get(name) : null,
    delta: delta.get(name) || 0,
    isNew: !knownProjects.has(name),
  })).sort((a, b) => (b.after ?? -1) - (a.after ?? -1) || a.name.localeCompare(b.name));

  return {
    totals, changes, projects, exceptions,
    emptyProjects: projects.filter((project) => project.after === 0).map((project) => project.name),
    // 화면이 "이 결정으로 ChatGPT의 어떤 것이 바뀌는가"를 한 줄로 말할 수 있게 한다.
    headline: headline(totals, changes),
  };
}

function headline(totals, changes) {
  const parts = [];
  if (totals.delete) parts.push(`삭제 ${totals.delete}건`);
  if (totals.trashed) parts.push(`삭제후보 프로젝트로 이동 ${totals.trashed}건`);
  if (totals.marked) parts.push(`삭제 표시 ${totals.marked}건`);
  if (changes.move) parts.push(`프로젝트 이동 ${changes.move}건`);
  if (changes.rename) parts.push(`제목 변경 ${changes.rename}건`);
  if (changes.newProjects.length) parts.push(`새 프로젝트 ${changes.newProjects.length}개`);
  if (!parts.length) return "바뀌는 것이 없습니다";
  return parts.join(" · ");
}

// 적용을 마친 뒤의 결과 보고서. catalogAfter 는 이번 실행의 결과 카탈로그다(스캔 카탈로그에 승인된 결정을 반영한 것).
export function buildResultReport({ catalogBefore, catalogAfter, rows, renameOrder = null, finishedAt = new Date().toISOString() }) {
  const plan = buildReviewSummary({ catalog: catalogBefore, rows });
  const afterCounts = countByProject(catalogAfter);
  const rowTitle = new Map(rows.map((row) => [row.conversationId, row.newTitle || row.title]));
  const projects = plan.projects.map((project) => ({
    ...project,
    actualAfter: afterCounts.has(project.name) ? afterCounts.get(project.name) : null,
    matches: !afterCounts.has(project.name) || afterCounts.get(project.name) === project.after,
  }));
  const mismatches = projects.filter((project) => !project.matches).map((project) => project.name);
  return {
    finishedAt,
    headline: plan.headline,
    totals: plan.totals,
    changes: plan.changes,
    projects,
    mismatches,
    renameOrder,
    // 무엇이 어떻게 바뀌었는지 대화별로 남긴다(화면·보고서에서 확인용).
    details: { renames: plan.exceptions.renames, moves: plan.exceptions.moves, trashed: plan.exceptions.trashed.map((item) => ({ ...item, title: rowTitle.get(item.conversationId) || item.title })) },
    todo: {
      deleteEmptyProjects: [...afterCounts.entries()].filter(([, count]) => count === 0).map(([name]) => name).sort(),
      removeFromProject: plan.exceptions.manualRemoves,
      deleteYourself: plan.exceptions.marked,
    },
    note: "제목 변경·삭제·이동은 적용하면서 대화마다 다시 읽어 확인했고, 그 기록(영수증)이 이 실행 폴더에 있습니다.",
  };
}

export function reportMarkdown(report) {
  const lines = [`# 정리 결과 (${report.finishedAt})`, "", `**${report.headline}**`, "", report.note, ""];
  lines.push("## 프로젝트별 변화", "", "| 프로젝트 | 이전 | 이후 | 변화 |", "| --- | ---: | ---: | ---: |");
  for (const project of report.projects.filter((item) => item.delta !== 0 || item.isNew)) {
    lines.push(`| ${project.name}${project.isNew ? " (신규)" : ""} | ${project.before ?? "—"} | ${project.actualAfter ?? "—"} | ${project.delta > 0 ? "+" : ""}${project.delta} |`);
  }
  if (report.mismatches.length) lines.push("", `⚠ 예상과 실제가 다른 프로젝트: ${report.mismatches.join(", ")}`);
  if (report.renameOrder?.renamed) {
    lines.push("", report.renameOrder.preserved
      ? `제목을 바꾼 ${report.renameOrder.renamed}건은 ChatGPT 목록에서 원래의 상대 순서를 유지했습니다(바꾸지 않은 대화보다는 위로 올라옵니다).`
      : `⚠ 제목을 바꾼 ${report.renameOrder.renamed}건 중 ${report.renameOrder.outOfOrder.length}건의 목록 순서가 원래와 달라졌습니다.`);
  }
  const details = report.details || {};
  if (details.renames?.length) lines.push("", "## 바뀐 제목", "", ...details.renames.map((item) => `- ${item.from} → ${item.to}`));
  if (details.moves?.length) lines.push("", "## 옮긴 대화", "", ...details.moves.map((item) => `- ${item.title}: ${item.from || "프로젝트 없음"} → ${item.to}`));
  if (details.trashed?.length) lines.push("", "## 삭제후보로 보낸 대화", "", ...details.trashed.map((item) => `- ${item.title}${item.project ? ` (원래: ${item.project})` : ""}${item.why ? ` — ${item.why}` : ""}`));
  lines.push("", "## 직접 하실 일");
  if (!report.todo.deleteEmptyProjects.length && !report.todo.removeFromProject.length && !report.todo.deleteYourself.length) lines.push("", "없습니다.");
  if (report.todo.deleteYourself.length) {
    lines.push("", "삭제 후보로 표시만 한 대화(ChatGPT에서 직접 지우세요):",
      ...report.todo.deleteYourself.map((item) => `- ${item.title}${item.project ? ` (프로젝트: ${item.project})` : ""}`));
  }
  if (report.todo.deleteEmptyProjects.length) {
    lines.push("", "비어 있는 프로젝트(필요 없으면 ChatGPT에서 삭제):", ...report.todo.deleteEmptyProjects.map((name) => `- ${name}`));
  }
  if (report.todo.removeFromProject.length) {
    lines.push("", "프로젝트에서 직접 빼야 하는 대화(API로 뺄 수 없음):",
      ...report.todo.removeFromProject.map((item) => `- ${item.title} (현재: ${item.project})`));
  }
  return `${lines.join("\n")}\n`;
}
