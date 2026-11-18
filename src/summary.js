import { translate, translator } from "./i18n.js";

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
      // 삭제후보를 어느 프로젝트로도 옮기지 않고 표시만 하는 행. 사용자가 ChatGPT에서 직접 지운다.
      totals.marked += 1;
      exceptions.marked.push(brief);
      if (renaming) {
        changes.rename += 1;
        exceptions.renames.push({ conversationId: row.conversationId, from: row.title, to: row.newTitle });
      }
      continue;
    }
    if (row.trashed) {
      // 삭제후보를 삭제후보 프로젝트로 옮기는 행. 삭제가 아니라 이동이며 사용자가 나중에 직접 확인한다.
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
    headline: summaryHeadline({ totals, changes }),
  };
}

export function summaryHeadline({ totals, changes }, locale) {
  const t = translator(locale);
  const counts = { delete: totals.delete, trashed: totals.trashed, marked: totals.marked,
    move: changes.move, rename: changes.rename, newProjects: changes.newProjects.length };
  const parts = Object.entries(counts).filter(([, count]) => count > 0)
    .map(([kind, count]) => t(`summary.${kind}`, { count }));
  return parts.length ? parts.join(" · ") : t("summary.noChanges");
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
    note: translate(undefined, "summary.note"),
  };
}

export function reportMarkdown(report, locale) {
  const t = translator(locale);
  const lines = [`# ${t("report.heading", { when: report.finishedAt })}`, "", `**${summaryHeadline(report, locale)}**`, "", t("summary.note"), ""];
  lines.push(`## ${t("result.project.changes")}`, "", t("report.table"), "| --- | ---: | ---: | ---: |");
  for (const project of report.projects.filter((item) => item.delta !== 0 || item.isNew)) {
    lines.push(`| ${project.name}${project.isNew ? t("result.new") : ""} | ${project.before ?? "—"} | ${project.actualAfter ?? "—"} | ${project.delta > 0 ? "+" : ""}${project.delta} |`);
  }
  if (report.mismatches.length) lines.push("", t("report.mismatch", { projects: report.mismatches.join(", ") }));
  if (report.renameOrder?.renamed) {
    lines.push("", report.renameOrder.preserved
      ? t("report.ordered", { count: report.renameOrder.renamed })
      : t("report.unordered", { count: report.renameOrder.renamed, changed: report.renameOrder.outOfOrder.length }));
  }
  const details = report.details || {};
  if (details.renames?.length) lines.push("", `## ${t("report.renames")}`, "", ...details.renames.map((item) => `- ${item.from} → ${item.to}`));
  if (details.moves?.length) lines.push("", `## ${t("report.moves")}`, "", ...details.moves.map((item) => `- ${item.title}: ${item.from || t("result.no.project")} → ${item.to}`));
  if (details.trashed?.length) lines.push("", `## ${t("report.trashed")}`, "", ...details.trashed.map((item) => `- ${item.title}${item.project ? t("report.previousProject", { project: item.project }) : ""}${item.why ? ` — ${item.why}` : ""}`));
  lines.push("", `## ${t("result.actions.for.you")}`);
  if (!report.todo.deleteEmptyProjects.length && !report.todo.removeFromProject.length && !report.todo.deleteYourself.length) lines.push("", t("result.none"));
  if (report.todo.deleteYourself.length) {
    lines.push("", t("report.manualDelete"),
      ...report.todo.deleteYourself.map((item) => `- ${item.title}${item.project ? t("report.project", { project: item.project }) : ""}`));
  }
  if (report.todo.deleteEmptyProjects.length) {
    lines.push("", t("report.emptyProjects"), ...report.todo.deleteEmptyProjects.map((name) => `- ${name}`));
  }
  if (report.todo.removeFromProject.length) {
    lines.push("", t("report.manualRemove"),
      ...report.todo.removeFromProject.map((item) => `- ${item.title}${t("report.currentProject", { project: item.project })}`));
  }
  return `${lines.join("\n")}\n`;
}
