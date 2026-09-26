import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildClaudePrompt, writeClassificationReview } from "../src/classification-review.js";
import { CLASSIFICATION_CRITERIA } from "../src/classification-criteria.js";
import { compileProjectRouting, compileReviewedDecisions } from "../src/decision-compile.js";
import { validateClassificationProposals } from "../src/proposal-validation.js";
import { buildInventory } from "./support/export-inventory.js";
import { managementManifestDigest } from "../src/management.js";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

function writeConversation(path, id, title, archived = false) {
  writeFileSync(path, JSON.stringify({
    conversation_id: id,
    title,
    create_time: 1,
    update_time: 2,
    is_archived: archived,
    mapping: {
      root: { message: null },
      one: { message: { content: { parts: ["hello"] }, metadata: {} } },
    },
  }));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-workflow-test-"));
  mkdirSync(join(root, "json"), { recursive: true });
  mkdirSync(join(root, "projects", "Project A", "json"), { recursive: true });
  writeConversation(join(root, "json", "one.json"), ID1, "General");
  writeConversation(join(root, "projects", "Project A", "json", "two.json"), ID2, "Project chat", true);
  writeFileSync(join(root, "projects", "Project A", "project-info.md"), "# Project A\n");
  writeFileSync(join(root, "export-summary.json"), JSON.stringify({
    total: 2,
    failed: 0,
    complete: true,
    dateFrom: null,
    dateTo: null,
    scope: { conversations: true, projectMetadata: true, attachments: false, formats: { json: true } },
    discoveredTotal: 2,
    skipped: 0,
    conversationIds: [ID1, ID2],
  }));
  return root;
}

test("classification review keeps only the current user and final-assistant path", () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-review-test-"));
  try {
    const backupPath = join(root, "conversation.json");
    writeFileSync(backupPath, JSON.stringify({
      conversation_id: ID1,
      title: "검토 대상 — 최종 결과",
      current_node: "final",
      mapping: {
        root: { parent: null, message: null },
        user: {
          parent: "root",
          message: {
            author: { role: "user" },
            content: { content_type: "multimodal_text", parts: ["사용자 요청", { asset_pointer: "hidden" }] },
            metadata: { attachments: [{ name: "reference.pdf", mime_type: "application/pdf" }] },
          },
        },
        hidden: {
          parent: "user",
          message: {
            author: { role: "assistant" },
            content: { content_type: "thoughts", parts: ["내부 추론"] },
            metadata: { is_visually_hidden_from_conversation: true },
          },
        },
        tool: {
          parent: "hidden",
          message: { author: { role: "tool" }, content: { content_type: "text", parts: ["도구 결과"] } },
        },
        final: {
          parent: "tool",
          message: {
            author: { role: "assistant" },
            end_turn: true,
            content: {
              content_type: "text",
              parts: ["최종 답변 citeturn1search0 [결과 파일](sandbox:/mnt/data/result.csv)"],
            },
            metadata: {},
          },
        },
        alternate: {
          parent: "user",
          message: {
            author: { role: "assistant" },
            end_turn: true,
            content: { content_type: "text", parts: ["선택되지 않은 분기"] },
            metadata: {},
          },
        },
      },
    }));
    const raw = readFileSync(backupPath);
    const inventoryPath = join(root, "inventory.json");
    writeFileSync(inventoryPath, JSON.stringify({
      version: 1,
      kind: "conversation-maintenance-inventory",
      warnings: [],
      projects: [{ projectName: "Project A", conversationCount: 1, sampleTitles: [] }],
      conversations: [{
        conversationId: ID1,
        title: "검토 대상 — 최종 결과",
        projectName: "Project A",
        reasons: ["new"],
        createTime: 1,
        updateTime: 2,
        attachmentReferenceCount: 2,
        backupFile: backupPath,
        backupSha256: createHash("sha256").update(raw).digest("hex"),
      }],
    }));
    const outputPath = join(root, "review.json");
    const result = writeClassificationReview(
      inventoryPath,
      outputPath,
      () => new Date("2026-08-27T00:00:00Z"),
    );
    const review = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(result.counts.sourceMessages, 5);
    assert.equal(result.counts.reviewMessages, 2);
    assert.equal(result.counts.excludedMessages, 3);
    assert.deepEqual(review.conversations[0].messages, [
      {
        role: "user",
        text: "사용자 요청",
        attachments: [{ name: "reference.pdf", mimeType: "application/pdf" }],
        nonTextPartCount: 1,
      },
      { role: "assistant", text: "최종 답변  [결과 파일](산출물)" },
    ]);
    assert.equal(review.conversations[0].messages.some((item) => item.text.includes("내부 추론")), false);
    assert.equal(review.conversations[0].messages.some((item) => item.text.includes("선택되지 않은 분기")), false);
    assert.match(review.inventoryDigest, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classification review excerpts long messages, windows long paths, and trims project context", () => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-review-reduce-test-"));
  try {
    const long = "가".repeat(4000);
    const mapping = { root: { parent: null, message: null } };
    let parent = "root";
    const turns = 12;
    for (let index = 0; index < turns; index++) {
      const userId = `u${index}`;
      const asstId = `a${index}`;
      mapping[userId] = {
        parent,
        message: {
          author: { role: "user" },
          content: { content_type: "text", parts: [`요청 ${index} ${index === 0 ? long : ""}`] },
          metadata: {},
        },
      };
      mapping[asstId] = {
        parent: userId,
        message: {
          author: { role: "assistant" },
          end_turn: true,
          content: { content_type: "text", parts: [`응답 ${index}`] },
          metadata: {},
        },
      };
      parent = asstId;
    }
    const backupPath = join(root, "conversation.json");
    writeFileSync(backupPath, JSON.stringify({
      conversation_id: ID1,
      title: "검토 대상 — 최종 결과",
      current_node: parent,
      mapping,
    }));
    const raw = readFileSync(backupPath);
    const inventoryPath = join(root, "inventory.json");
    writeFileSync(inventoryPath, JSON.stringify({
      version: 1,
      kind: "conversation-maintenance-inventory",
      warnings: [],
      projects: [
        { projectName: "Project A", conversationCount: 3, sampleTitles: ["예시 — 제목"] },
        { projectName: "Project B", conversationCount: 9, sampleTitles: ["다른 — 제목", "또 — 제목"] },
      ],
      conversations: [{
        conversationId: ID1,
        title: "검토 대상 — 최종 결과",
        projectName: "Project A",
        reasons: ["new"],
        createTime: 1,
        updateTime: 2,
        attachmentReferenceCount: 0,
        backupFile: backupPath,
        backupSha256: createHash("sha256").update(raw).digest("hex"),
      }],
    }));
    const outputPath = join(root, "review.json");
    writeClassificationReview(inventoryPath, outputPath, () => new Date("2026-08-30T00:00:00Z"));
    const review = JSON.parse(readFileSync(outputPath, "utf8"));

    assert.deepEqual(review.criteria, CLASSIFICATION_CRITERIA);
    const conversation = review.conversations[0];
    assert.equal(conversation.messages.length, 6);
    assert.equal(conversation.omittedMessages, 2 * turns - 6);
    const first = conversation.messages[0];
    assert.equal(typeof first.head, "string");
    assert.equal(typeof first.tail, "string");
    assert.ok(first.chars > 3000);
    assert.equal(first.text, undefined);

    const projectA = review.projects.find((item) => item.projectName === "Project A");
    const projectB = review.projects.find((item) => item.projectName === "Project B");
    assert.deepEqual(projectA.sampleTitles, ["예시 — 제목"]);
    assert.equal(projectB.sampleTitles, undefined);
    assert.equal(projectB.conversationCount, 9);
    assert.equal(review.counts.projectsWithContext, 1);

    const prompt = buildClaudePrompt(review, { inventoryPath, proposalPath: join(root, "proposal.json") });
    assert.match(prompt, /판단 기준/);
    assert.match(prompt, new RegExp(review.inventoryDigest));
    assert.match(prompt, /classification-proposals/);
    assert.equal(prompt.includes("AGENTS.md"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reviewed decisions compile to small, source-bound management manifests", () => {
  const root = fixture();
  try {
    const inventoryPath = join(root, "inventory.json");
    const inventory = { ...buildInventory(root), kind: "conversation-maintenance-inventory" };
    writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2));
    const inventoryDigest = createHash("sha256").update(readFileSync(inventoryPath)).digest("hex");
    const decisionsPath = join(root, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify({
      version: 1,
      kind: "reviewed-decisions",
      inventoryDigest,
      receiptDir: join(root, "receipts"),
      decisions: [
        { conversationId: ID1, decision: "keep", trashed: true, newTitle: "삭제후보 — 표준 제목", reviewed: true },
        { conversationId: ID2, decision: "delete", reviewed: true, rationale: "cleanup" },
      ],
    }, null, 2));

    const result = compileReviewedDecisions(inventoryPath, decisionsPath, join(root, "plans"));
    assert.equal(result.manifests.length, 1);
    assert.equal(result.skippedKeep, 0);
    const manifest = JSON.parse(readFileSync(result.manifests[0].path, "utf8"));
    // 삭제후보으로 옮기는 ID1은 표준 제목으로 바꾸는 제목 변경이 함께 계획된다.
    assert.equal(manifest.actions.length, 2);
    assert.ok(manifest.actions.some((action) => action.conversationId === ID2 && action.decision === "delete"));
    assert.match(manifest.actions[0].backupSha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.source.inventoryDigest, inventoryDigest);
    assert.equal(result.manifests[0].digest, managementManifestDigest(manifest));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("maintenance decisions can create no-op management plans and one source-bound routing plan", () => {
  const root = fixture();
  try {
    const full = buildInventory(root);
    const source = { ...full.conversations[0], title: "General — Review" };
    const inventoryPath = join(root, "maintenance-inventory.json");
    writeFileSync(inventoryPath, JSON.stringify({
      version: 1,
      kind: "conversation-maintenance-inventory",
      warnings: [],
      conversations: [source],
    }, null, 2));
    const inventoryDigest = createHash("sha256").update(readFileSync(inventoryPath)).digest("hex");
    const decisionsPath = join(root, "maintenance-decisions.json");
    writeFileSync(decisionsPath, JSON.stringify({
      version: 1,
      kind: "reviewed-decisions",
      inventoryDigest,
      receiptDir: join(root, "receipts"),
      decisions: [{
        conversationId: source.conversationId,
        decision: "keep",
        projectName: "Project B",
        reviewed: true,
      }],
    }, null, 2));

    const result = compileReviewedDecisions(inventoryPath, decisionsPath, join(root, "plans"));
    assert.equal(result.manifests.length, 0);
    assert.equal(result.skippedKeep, 1);
    const routingResult = compileProjectRouting(
      inventoryPath,
      decisionsPath,
      join(root, "routing.json"),
    );
    assert.equal(routingResult.routingRequired, true);
    const routing = JSON.parse(readFileSync(routingResult.routingPath, "utf8"));
    assert.equal(routing.targets[0].project.name, "Project B");
    assert.equal(routing.targets[0].actions[0].conversationId, source.conversationId);
    assert.equal(routing.targets[0].actions[0].expectedTitle, source.title);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("moving a conversation already in a project compiles a named-source routing target", () => {
  const root = fixture();
  try {
    const full = buildInventory(root);
    const source = { ...full.conversations[0], title: "General — Review", projectName: "Project A" };
    const inventoryPath = join(root, "maintenance-inventory.json");
    writeFileSync(inventoryPath, JSON.stringify({
      version: 1,
      kind: "conversation-maintenance-inventory",
      warnings: [],
      conversations: [source],
    }, null, 2));
    const inventoryDigest = createHash("sha256").update(readFileSync(inventoryPath)).digest("hex");
    const decisionsPath = join(root, "maintenance-decisions.json");
    writeFileSync(decisionsPath, JSON.stringify({
      version: 1,
      kind: "reviewed-decisions",
      inventoryDigest,
      receiptDir: join(root, "receipts"),
      decisions: [{
        conversationId: source.conversationId,
        decision: "keep",
        projectName: "Project B",
        reviewed: true,
      }],
    }, null, 2));

    const routingResult = compileProjectRouting(inventoryPath, decisionsPath, join(root, "routing.json"));
    assert.equal(routingResult.routingRequired, true);
    const routing = JSON.parse(readFileSync(routingResult.routingPath, "utf8"));
    assert.equal(routing.targets[0].project.name, "Project B");
    assert.equal(routing.targets[0].actions[0].conversationId, source.conversationId);
    assert.equal(routing.targets[0].actions[0].expectedSourceProjectId, null);
    assert.deepEqual(routing.targets[0].sourceProjectNames, { [source.conversationId]: "Project A" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classification proposals are source-bound and validate project routing semantics", () => {
  const root = fixture();
  try {
    const source = {
      ...buildInventory(root).conversations[0],
      reasons: ["new", "project-required", "title-format"],
    };
    const projects = [{
      projectName: "Project A",
      conversationCount: 1,
      sampleTitles: ["프로젝트 자료 — 검토 결과 정리"],
    }];
    const catalogPath = join(root, "catalog.json");
    writeFileSync(catalogPath, JSON.stringify({
      version: 1,
      kind: "conversation-maintenance-catalog",
      projects,
      conversations: [
        source,
        { conversationId: ID2, title: "프로젝트 자료 — 검토 결과 정리", projectName: "Project A" },
      ],
    }));
    const inventoryPath = join(root, "maintenance-proposal-inventory.json");
    writeFileSync(inventoryPath, JSON.stringify({
      version: 1,
      kind: "conversation-maintenance-inventory",
      warnings: [],
      catalogFile: catalogPath,
      projects,
      conversations: [source],
    }));
    const inventoryDigest = createHash("sha256").update(readFileSync(inventoryPath)).digest("hex");
    const proposalPath = join(root, "proposal.json");
    writeFileSync(proposalPath, JSON.stringify({
      version: 1,
      kind: "classification-proposals",
      inventoryDigest,
      scope: { candidateCount: 1 },
      items: [{
        conversationId: source.conversationId,
        currentTitle: source.title,
        projectName: null,
        reasons: source.reasons,
        suggestedDecision: "keep",
        suggestedNewTitle: "일반 대화 검토 — 제목과 프로젝트 정리",
        suggestedProjectAction: "use-or-create",
        suggestedProjectName: "Project A",
        confidence: "high",
        rationale: "고유한 검토 결과가 있다",
        projectRationale: "기존 프로젝트의 자료와 목적을 재사용한다",
      }],
    }));

    const result = validateClassificationProposals(inventoryPath, proposalPath);
    assert.equal(result.ok, true);
    assert.deepEqual(result.decisionCounts, { keep: 1, delete: 0, undecided: 0 });
    assert.deepEqual(result.warnings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classification proposal validation warns about duplicate final titles", () => {
  const root = fixture();
  try {
    const duplicateTitle = "프로젝트 자료 — 검토 결과와 후속 정리";
    const source = { ...buildInventory(root).conversations[0], reasons: ["new"] };
    const projects = [{ projectName: "Project A", conversationCount: 1, sampleTitles: [duplicateTitle] }];
    const catalogPath = join(root, "catalog.json");
    writeFileSync(catalogPath, JSON.stringify({
      version: 1,
      kind: "conversation-maintenance-catalog",
      projects,
      conversations: [source, { conversationId: ID2, title: duplicateTitle, projectName: "Project A" }],
    }));
    const inventoryPath = join(root, "maintenance-proposal-inventory.json");
    writeFileSync(inventoryPath, JSON.stringify({
      version: 1,
      kind: "conversation-maintenance-inventory",
      warnings: [],
      catalogFile: catalogPath,
      projects,
      conversations: [source],
    }));
    const inventoryDigest = createHash("sha256").update(readFileSync(inventoryPath)).digest("hex");
    const proposalPath = join(root, "proposal.json");
    writeFileSync(proposalPath, JSON.stringify({
      version: 1,
      kind: "classification-proposals",
      inventoryDigest,
      scope: { candidateCount: 1 },
      items: [{
        conversationId: source.conversationId,
        currentTitle: source.title,
        projectName: null,
        reasons: source.reasons,
        suggestedDecision: "keep",
        suggestedNewTitle: duplicateTitle,
        suggestedProjectAction: "use-or-create",
        suggestedProjectName: "Project A",
        confidence: "medium",
        rationale: "고유한 결과가 있다",
        projectRationale: "기존 프로젝트와 같은 자료를 사용한다",
      }],
    }));

    const result = validateClassificationProposals(inventoryPath, proposalPath);
    assert.match(result.warnings.join("\n"), /Duplicate final title/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("maintenance reviewed decisions reject unresolved or archive-only states", () => {
  for (const decision of ["archive", "undecided"]) {
    const root = fixture();
    try {
      const source = { ...buildInventory(root).conversations[0], title: "일반 대화 — 검토 결과 정리" };
      const inventoryPath = join(root, "maintenance-state-decision.json");
      writeFileSync(inventoryPath, JSON.stringify({
        version: 1,
        kind: "conversation-maintenance-inventory",
        warnings: [],
        conversations: [source],
      }));
      const inventoryDigest = createHash("sha256").update(readFileSync(inventoryPath)).digest("hex");
      const decisionsPath = join(root, "maintenance-state-reviewed.json");
      writeFileSync(decisionsPath, JSON.stringify({
        version: 1,
        kind: "reviewed-decisions",
        inventoryDigest,
        receiptDir: join(root, "receipts"),
        decisions: [{
          conversationId: source.conversationId,
          decision,
          projectName: "Project A",
          reviewed: true,
        }],
      }));

      assert.throws(
        () => compileReviewedDecisions(inventoryPath, decisionsPath, join(root, "plans")),
        /decision must be keep or delete/,
      );
      assert.throws(
        () => compileProjectRouting(inventoryPath, decisionsPath, join(root, "routing.json")),
        /decision must be keep or delete/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("maintenance compiler rejects a kept title outside the canonical separator form", () => {
  const root = fixture();
  try {
    const source = buildInventory(root).conversations[0];
    const inventoryPath = join(root, "maintenance-invalid-title.json");
    writeFileSync(inventoryPath, JSON.stringify({
      version: 1,
      kind: "conversation-maintenance-inventory",
      warnings: [],
      conversations: [{ ...source, title: "Unformatted title" }],
    }));
    const inventoryDigest = createHash("sha256").update(readFileSync(inventoryPath)).digest("hex");
    const decisionsPath = join(root, "maintenance-invalid-decisions.json");
    writeFileSync(decisionsPath, JSON.stringify({
      version: 1,
      kind: "reviewed-decisions",
      inventoryDigest,
      receiptDir: join(root, "receipts"),
      decisions: [{ conversationId: source.conversationId, decision: "keep", reviewed: true }],
    }));
    assert.throws(() => compileReviewedDecisions(inventoryPath, decisionsPath, join(root, "plans")),
      /exact "topic — work\/result" title form/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler rejects AI-style decisions that were not user-reviewed", () => {
  const root = fixture();
  try {
    const inventoryPath = join(root, "inventory.json");
    writeFileSync(inventoryPath, JSON.stringify({ ...buildInventory(root), kind: "conversation-maintenance-inventory" }, null, 2));
    const inventoryDigest = createHash("sha256").update(readFileSync(inventoryPath)).digest("hex");
    const decisionsPath = join(root, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify({
      version: 1,
      kind: "reviewed-decisions",
      inventoryDigest,
      receiptDir: join(root, "receipts"),
      decisions: [{ conversationId: ID1, decision: "delete", reviewed: false }],
    }));
    assert.throws(() => compileReviewedDecisions(inventoryPath, decisionsPath, join(root, "plans")), /not reviewed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compiler refuses an inventory with export completeness warnings", () => {
  const root = fixture();
  try {
    const inventoryPath = join(root, "inventory.json");
    const inventory = { ...buildInventory(root), kind: "conversation-maintenance-inventory" };
    inventory.warnings.push("Export used a date filter and is not a full snapshot");
    writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2));
    const inventoryDigest = createHash("sha256").update(readFileSync(inventoryPath)).digest("hex");
    const decisionsPath = join(root, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify({
      version: 1,
      kind: "reviewed-decisions",
      inventoryDigest,
      receiptDir: join(root, "receipts"),
      decisions: [{ conversationId: ID1, decision: "delete", reviewed: true }],
    }));
    assert.throws(() => compileReviewedDecisions(inventoryPath, decisionsPath, join(root, "plans")),
      /Inventory is not safe to use/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a preserved conversation may stay projectless; one already in a project is reported as manual-remove", () => {
  const root = fixture();
  try {
    const base = buildInventory(root).conversations[0];
    const run = (projectName, action) => {
      const source = { ...base, projectName, reasons: ["overhaul"] };
      const inventoryPath = join(root, `inv-${action}.json`);
      const catalogPath = join(root, `cat-${action}.json`);
      writeFileSync(catalogPath, JSON.stringify({
        version: 1, kind: "conversation-maintenance-catalog", projects: [], conversations: [source],
      }));
      writeFileSync(inventoryPath, JSON.stringify({
        version: 1, kind: "conversation-maintenance-inventory", warnings: [],
        catalogFile: catalogPath, projects: [], conversations: [source],
      }));
      const inventoryDigest = createHash("sha256").update(readFileSync(inventoryPath)).digest("hex");
      const proposalPath = join(root, `prop-${action}.json`);
      writeFileSync(proposalPath, JSON.stringify({
        version: 1, kind: "classification-proposals", inventoryDigest, scope: { candidateCount: 1 },
        items: [{
          conversationId: source.conversationId, currentTitle: source.title, projectName, reasons: source.reasons,
          suggestedDecision: "keep", suggestedNewTitle: "일반 대화 검토 — 제목과 프로젝트 정리",
          suggestedProjectAction: action, suggestedProjectName: null,
          confidence: "high", rationale: "고유한 검토 결과가 있다",
        }],
      }));
      return validateClassificationProposals(inventoryPath, proposalPath);
    };
    assert.equal(run(null, "none").ok, true);
    assert.equal(run("Project A", "manual-remove").ok, true);
    assert.throws(() => run("Project A", "none"), /manual-remove/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
