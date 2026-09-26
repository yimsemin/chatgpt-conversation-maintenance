import assert from "node:assert/strict";
import test from "node:test";

import { buildResultReport, buildReviewSummary, reportMarkdown, rowsFromProposal } from "../summary.js";

const catalog = {
  projects: [{ projectName: "A" }, { projectName: "B" }, { projectName: "Empty" }],
  conversations: [
    { conversationId: "1", title: "가 — 결과", projectName: "A" },
    { conversationId: "2", title: "나 — 결과", projectName: "A" },
    { conversationId: "3", title: "다 — 결과", projectName: "B" },
    { conversationId: "4", title: "라 — 결과", projectName: null },
  ],
};

const rows = [
  { conversationId: "1", title: "가 — 결과", currentProject: "A", decision: "delete", why: "잡음", confidence: "high" },
  { conversationId: "2", title: "나 — 결과", currentProject: "A", decision: "keep", project: "B", confidence: "medium", newTitle: "나 — 새 결과" },
  { conversationId: "3", title: "다 — 결과", currentProject: "B", decision: "keep", project: null, confidence: "low" },
  { conversationId: "4", title: "라 — 결과", currentProject: null, decision: "keep", project: "New", confidence: "high" },
];

test("the review summary counts what will change and per-project deltas", () => {
  const summary = buildReviewSummary({ catalog, rows });
  assert.deepEqual(summary.totals, { candidates: 4, keep: 3, delete: 1, undecided: 0, trashed: 0, marked: 0 });
  assert.equal(summary.changes.move, 2);
  assert.equal(summary.changes.rename, 1);
  assert.equal(summary.changes.remove, 1);
  assert.deepEqual(summary.changes.newProjects, ["New"]);
  const byName = Object.fromEntries(summary.projects.map((p) => [p.name, p]));
  assert.equal(byName.A.after, 0);
  assert.equal(byName.B.after, 2);
  assert.equal(byName.New.isNew, true);
  assert.deepEqual(summary.emptyProjects.sort(), ["A", "Empty"]);
  assert.match(summary.headline, /삭제 1건 · 프로젝트 이동 2건 · 제목 변경 1건 · 새 프로젝트 1개/);
  assert.equal(summary.exceptions.lowConfidence.length, 1);
});

test("the result report lists the empty projects and manual removals the user must handle", () => {
  const after = {
    projects: [{ projectName: "A" }, { projectName: "B" }, { projectName: "Empty" }, { projectName: "New" }],
    conversations: [
      { conversationId: "2", projectName: "B" }, { conversationId: "3", projectName: "B" },
      { conversationId: "4", projectName: "New" },
    ],
  };
  const report = buildResultReport({ catalogBefore: catalog, catalogAfter: after, rows });
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(report.todo.deleteEmptyProjects, ["A", "Empty"]);
  assert.equal(report.todo.removeFromProject.length, 1);
  const markdown = reportMarkdown(report);
  assert.match(markdown, /비어 있는 프로젝트/);
  assert.match(markdown, /영수증/);
});

test("proposal items become rows and undecided items are counted separately", () => {
  const proposal = { items: [
    { conversationId: "1", currentTitle: "t", projectName: "A", suggestedDecision: "undecided", confidence: "low", rationale: "?" },
  ] };
  const built = rowsFromProposal(proposal, { conversations: [] });
  const summary = buildReviewSummary({ catalog, rows: built });
  assert.equal(summary.totals.undecided, 1);
  assert.equal(summary.exceptions.undecided.length, 1);
});

test("rows moved to the trash project count as custody, not deletions or moves", () => {
  const trashedRows = [
    { conversationId: "1", title: "가 — 결과", currentProject: "A", decision: "keep", project: "Park", trashed: true, why: "저가치" },
    { conversationId: "2", title: "나 — 결과", currentProject: "A", decision: "delete", why: "잡음" },
  ];
  const summary = buildReviewSummary({ catalog, rows: trashedRows });
  assert.equal(summary.totals.trashed, 1);
  assert.equal(summary.totals.delete, 1);
  assert.equal(summary.changes.move, 0);
  assert.match(summary.headline, /삭제 1건 · 삭제후보 프로젝트로 이동 1건/);
  const byName = Object.fromEntries(summary.projects.map((p) => [p.name, p]));
  assert.equal(byName.Park.after, 1);
  assert.equal(byName.A.after, 0);
});

test("marked rows stay where they are and become a to-do for the user", () => {
  const marked = [{ conversationId: "1", title: "가 — 결과", currentProject: "A", decision: "keep", project: "A", marked: true, why: "잡담" }];
  const summary = buildReviewSummary({ catalog, rows: marked });
  assert.equal(summary.totals.marked, 1);
  assert.equal(summary.changes.move, 0);
  assert.equal(summary.changes.remove, 0);
  assert.match(summary.headline, /삭제 표시 1건/);
  const after = { projects: catalog.projects, conversations: catalog.conversations };
  const report = buildResultReport({ catalogBefore: catalog, catalogAfter: after, rows: marked });
  assert.equal(report.todo.deleteYourself.length, 1);
  assert.match(reportMarkdown(report), /직접 지우세요/);
});

test("projects the scan did not read have unknown counts and only a delta", () => {
  const partial = { scope: { complete: false }, projects: [{ projectName: "Read", conversationCount: 1 }, { projectName: "Unread", conversationCount: null }],
    conversations: [{ conversationId: "1", title: "가 — 결과", projectName: "Read" }] };
  const moved = [{ conversationId: "1", title: "가 — 결과", currentProject: "Read", decision: "keep", project: "Unread", confidence: "high" }];
  const summary = buildReviewSummary({ catalog: partial, rows: moved });
  const byName = Object.fromEntries(summary.projects.map((p) => [p.name, p]));
  assert.deepEqual([byName.Read.before, byName.Read.after, byName.Read.delta], [1, 0, -1]);
  assert.deepEqual([byName.Unread.before, byName.Unread.after, byName.Unread.delta], [null, null, 1]);
  assert.deepEqual(summary.emptyProjects, ["Read"], "an unread project is never reported as empty");
  assert.equal(summary.changes.newProjects.length, 0);
});
