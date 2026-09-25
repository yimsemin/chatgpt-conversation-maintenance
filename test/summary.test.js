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
  assert.deepEqual(summary.totals, { candidates: 4, keep: 3, delete: 1, undecided: 0, parked: 0 });
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
  const report = buildResultReport({ catalogBefore: catalog, catalogAfter: after, rows, verification: "assume-quiet" });
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(report.todo.deleteEmptyProjects, ["A", "Empty"]);
  assert.equal(report.todo.removeFromProject.length, 1);
  const markdown = reportMarkdown(report);
  assert.match(markdown, /비어 있는 프로젝트/);
  assert.match(markdown, /빠른 검증/);
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

test("parked rows count as temporary custody, not deletions or moves", () => {
  const parkedRows = [
    { conversationId: "1", title: "가 — 결과", currentProject: "A", decision: "keep", project: "Park", parked: true, why: "저가치" },
    { conversationId: "2", title: "나 — 결과", currentProject: "A", decision: "delete", why: "잡음" },
  ];
  const summary = buildReviewSummary({ catalog, rows: parkedRows });
  assert.equal(summary.totals.parked, 1);
  assert.equal(summary.totals.delete, 1);
  assert.equal(summary.changes.move, 0);
  assert.match(summary.headline, /삭제 1건 · 임시 보관 1건/);
  const byName = Object.fromEntries(summary.projects.map((p) => [p.name, p]));
  assert.equal(byName.Park.after, 1);
  assert.equal(byName.A.after, 0);
});
