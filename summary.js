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

export function rowsFromDecisions(decisions, inventory, proposal = null) {
  const byId = new Map((inventory.conversations || []).map((item) => [item.conversationId, item]));
  const noteById = new Map((proposal?.items || []).map((item) => [item.conversationId, item]));
  return (decisions.decisions || []).map((item) => {
    const source = byId.get(item.conversationId) || {};
    const note = noteById.get(item.conversationId) || {};
    return {
      conversationId: item.conversationId,
      title: source.title ?? "",
      currentProject: source.projectName ?? null,
      decision: item.decision === "delete" ? "delete" : "keep",
      undecided: false,
      parked: item.parked === true,
      newTitle: item.newTitle || null,
      project: item.decision === "delete" ? null : (item.projectName ?? null),
      confidence: note.confidence || null,
      why: item.rationale || note.rationale || "",
      action: null,
    };
  });
}

function countByProject(catalog) {
  const counts = new Map();
  for (const project of catalog.projects || []) counts.set(project.projectName, 0);
  for (const conversation of catalog.conversations || []) {
    if (conversation.projectName) counts.set(conversation.projectName, (counts.get(conversation.projectName) || 0) + 1);
  }
  return counts;
}

function classify(row) {
  const moving = row.decision === "keep" && row.project && row.project !== row.currentProject;
  const manualRemove = row.decision === "keep" && !row.project && Boolean(row.currentProject);
  const renaming = row.decision === "keep" && row.newTitle && row.newTitle !== row.title;
  return { moving: Boolean(moving), manualRemove, renaming: Boolean(renaming) };
}

export function buildReviewSummary({ catalog, rows }) {
  const before = countByProject(catalog);
  const after = new Map(before);
  const bump = (name, by) => { if (name) after.set(name, (after.get(name) || 0) + by); };
  const knownProjects = new Set(before.keys());

  const totals = { candidates: rows.length, keep: 0, delete: 0, undecided: 0, parked: 0 };
  const changes = { rename: 0, move: 0, remove: 0, parked: 0, newProjects: [] };
  const exceptions = { deletes: [], lowConfidence: [], moves: [], renames: [], undecided: [], manualRemoves: [], parked: [] };
  const newProjects = new Set();

  for (const row of rows) {
    const { moving, manualRemove, renaming } = classify(row);
    const brief = { conversationId: row.conversationId, title: row.title, project: row.currentProject,
      why: row.why, confidence: row.confidence };
    if (row.undecided) { totals.undecided += 1; exceptions.undecided.push(brief); continue; }
    if (row.parked) {
      // 삭제 후보를 임시 보관 프로젝트로 옮기는 행. 삭제가 아니라 이동이며 사용자가 나중에 직접 확인한다.
      totals.parked += 1;
      changes.parked += 1;
      bump(row.currentProject, -1);
      bump(row.project, 1);
      if (!knownProjects.has(row.project)) newProjects.add(row.project);
      exceptions.parked.push(brief);
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

  const names = new Set([...before.keys(), ...after.keys()]);
  const projects = [...names].map((name) => ({
    name,
    before: before.get(name) || 0,
    after: after.get(name) || 0,
    delta: (after.get(name) || 0) - (before.get(name) || 0),
    isNew: !knownProjects.has(name),
  })).sort((a, b) => b.after - a.after || a.name.localeCompare(b.name));

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
  if (totals.parked) parts.push(`임시 보관 ${totals.parked}건`);
  if (changes.move) parts.push(`프로젝트 이동 ${changes.move}건`);
  if (changes.rename) parts.push(`제목 변경 ${changes.rename}건`);
  if (changes.newProjects.length) parts.push(`새 프로젝트 ${changes.newProjects.length}개`);
  if (!parts.length) return "바뀌는 것이 없습니다";
  return parts.join(" · ");
}

// 적용을 마친 뒤의 결과 보고서. after 는 적용 후 기준선 카탈로그다.
export function buildResultReport({ catalogBefore, catalogAfter, rows, verification = "full", finishedAt = new Date().toISOString() }) {
  const plan = buildReviewSummary({ catalog: catalogBefore, rows });
  const afterCounts = countByProject(catalogAfter);
  const projects = plan.projects.map((project) => ({
    ...project,
    actualAfter: afterCounts.get(project.name) ?? 0,
    matches: (afterCounts.get(project.name) ?? 0) === project.after,
  }));
  const mismatches = projects.filter((project) => !project.matches).map((project) => project.name);
  return {
    finishedAt,
    verification,
    headline: plan.headline,
    totals: plan.totals,
    changes: plan.changes,
    projects,
    mismatches,
    todo: {
      deleteEmptyProjects: [...afterCounts.entries()].filter(([, count]) => count === 0).map(([name]) => name).sort(),
      removeFromProject: plan.exceptions.manualRemoves,
    },
    note: verification === "assume-quiet"
      ? "간단 확인(빠른 검증)으로 확정한 결과입니다. 적용하는 동안 다른 대화가 바뀌지 않았다는 가정이 들어 있으므로 가끔 고급 메뉴의 ‘ChatGPT 상태 다시 맞추기’로 전체를 확인하세요."
      : "전체 재수집으로 검증한 결과입니다.",
  };
}

export function reportMarkdown(report) {
  const lines = [`# 정리 결과 (${report.finishedAt})`, "", `**${report.headline}**`, "", report.note, ""];
  lines.push("## 프로젝트별 변화", "", "| 프로젝트 | 이전 | 이후 | 변화 |", "| --- | ---: | ---: | ---: |");
  for (const project of report.projects.filter((item) => item.delta !== 0 || item.isNew)) {
    lines.push(`| ${project.name}${project.isNew ? " (신규)" : ""} | ${project.before} | ${project.actualAfter} | ${project.delta > 0 ? "+" : ""}${project.delta} |`);
  }
  if (report.mismatches.length) lines.push("", `⚠ 예상과 실제가 다른 프로젝트: ${report.mismatches.join(", ")}`);
  lines.push("", "## 직접 하실 일");
  if (!report.todo.deleteEmptyProjects.length && !report.todo.removeFromProject.length) lines.push("", "없습니다.");
  if (report.todo.deleteEmptyProjects.length) {
    lines.push("", "비어 있는 프로젝트(필요 없으면 ChatGPT에서 삭제):", ...report.todo.deleteEmptyProjects.map((name) => `- ${name}`));
  }
  if (report.todo.removeFromProject.length) {
    lines.push("", "프로젝트에서 직접 빼야 하는 대화(API로 뺄 수 없음):",
      ...report.todo.removeFromProject.map((item) => `- ${item.title} (현재: ${item.project})`));
  }
  return `${lines.join("\n")}\n`;
}
