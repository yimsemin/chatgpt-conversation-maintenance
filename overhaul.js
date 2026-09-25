#!/usr/bin/env node
// 전수 재정비용 카드 도구. 에이전트는 이 도구가 만든 조각 파일만 읽고 카드·판정 파일만 쓴다.
// slice: 인벤토리를 무작위·균등하게 N조각으로 나눈다.
// validate-cards: 모든 대화가 정확히 한 장의 카드를 갖는지 검사한다.
// assemble: 판정(verdicts)을 기존 proposal.json 스키마로 조립하고 기존 검증기를 통과시킨다.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assert } from "./assert.js";
import { sha256 } from "./content-hash.js";
import { isNormalizedTitle } from "./title-rules.js";
import { classificationReviewConversation, validateClassificationProposals } from "./workflow.js";

const CARD_STATES = new Set(["active", "done", "superseded", "oneoff", "test"]);
const CARD_VALUES = new Set(["high", "mid", "low", "none"]);
const CARD_HARMS = new Set(["none", "stale", "conflicts-with-source"]);
const VERDICTS = new Set(["keep", "delete", "undecided"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadInventory(path) {
  const raw = readFileSync(path);
  const inventory = JSON.parse(raw.toString("utf8"));
  assert(inventory?.kind === "conversation-maintenance-inventory" && Array.isArray(inventory.conversations),
    "A maintenance inventory is required");
  return { inventory, digest: sha256(raw) };
}

// 시드 고정 PRNG(mulberry32)로 같은 시드는 같은 조각을 만든다.
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sliceInventory(inventoryPath, outputDir, { parts, seed = 1 }) {
  assert(Number.isInteger(parts) && parts > 0, "--parts must be a positive integer");
  const { inventory, digest } = loadInventory(inventoryPath);
  const items = inventory.conversations.map((item) => item.conversationId).sort();
  const random = seededRandom(seed);
  for (let index = items.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [items[index], items[other]] = [items[other], items[index]];
  }
  const byId = new Map(inventory.conversations.map((item) => [item.conversationId, item]));
  const out = resolve(outputDir);
  mkdirSync(out, { recursive: true });
  assert(readdirSync(out).length === 0, `Output directory is not empty: ${out}`);
  const summary = [];
  for (let part = 0; part < parts; part++) {
    const ids = items.filter((_, index) => index % parts === part);
    const conversations = ids.map((id) => classificationReviewConversation(byId.get(id)));
    const file = join(out, `slice-${String(part + 1).padStart(2, "0")}.json`);
    writeFileSync(file, JSON.stringify({ version: 1, kind: "overhaul-slice", inventoryDigest: digest,
      conversations }, null, 2), { mode: 0o600 });
    summary.push({ file, conversations: ids.length,
      reviewChars: conversations.reduce((sum, item) => sum + item.reviewChars, 0) });
  }
  return { inventoryDigest: digest, seed, slices: summary };
}

function cardFiles(cardsDir) {
  return readdirSync(resolve(cardsDir)).filter((name) => name.endsWith(".json")).sort()
    .map((name) => join(resolve(cardsDir), name));
}

function readEntries(directory, label) {
  const entries = [];
  for (const file of cardFiles(directory)) {
    const data = readJson(file);
    assert(Array.isArray(data), `${label} file must be a JSON array: ${file}`);
    entries.push(...data);
  }
  return entries;
}

function assertCoverage(entries, inventory, label, idKey = "id") {
  const expected = new Set(inventory.conversations.map((item) => item.conversationId));
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    assert(entry && typeof entry === "object", `${label}[${index}] must be an object`);
    const id = entry[idKey];
    assert(expected.has(id), `${label}[${index}] refers to an unknown conversation: ${id}`);
    assert(!seen.has(id), `${label}[${index}] is duplicated: ${id}`);
    seen.add(id);
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  assert(missing.length === 0, `${label} is missing ${missing.length} conversation(s): ${missing.slice(0, 5).join(", ")}`);
}

export function validateCards(inventoryPath, cardsDir) {
  const { inventory } = loadInventory(inventoryPath);
  const cards = readEntries(cardsDir, "cards");
  assertCoverage(cards, inventory, "cards");
  const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
  for (const [index, card] of cards.entries()) {
    const label = `cards[${index}]`;
    assert(nonEmpty(card.topic) && [...card.topic].length <= 30, `${label}.topic must be 1-30 characters`);
    assert(Array.isArray(card.refs) && card.refs.every(nonEmpty), `${label}.refs must be an array of names`);
    assert(CARD_STATES.has(card.state), `${label}.state is invalid`);
    assert(CARD_VALUES.has(card.value), `${label}.value is invalid`);
    assert(CARD_HARMS.has(card.harm), `${label}.harm is invalid`);
    assert(nonEmpty(card.why), `${label}.why is required`);
    assert(card.title === null || (nonEmpty(card.title) && isNormalizedTitle(card.title)),
      `${label}.title must be null or the "topic — work/result" form`);
  }
  return { ok: true, cards: cards.length };
}

// 판정 항목: {id, decision, title|null, project|null, confidence, why, projectWhy?}
export function assembleProposal(inventoryPath, verdictsDir, outputPath) {
  const { inventory, digest } = loadInventory(inventoryPath);
  const verdicts = readEntries(verdictsDir, "verdicts");
  assertCoverage(verdicts, inventory, "verdicts");
  const verdictById = new Map(verdicts.map((item) => [item.id, item]));
  const items = inventory.conversations.map((source) => {
    const verdict = verdictById.get(source.conversationId);
    assert(VERDICTS.has(verdict.decision), `verdict ${source.conversationId}: decision is invalid`);
    assert(CONFIDENCE.has(verdict.confidence), `verdict ${source.conversationId}: confidence is invalid`);
    const base = {
      conversationId: source.conversationId,
      currentTitle: source.title,
      projectName: source.projectName ?? null,
      reasons: source.reasons,
      suggestedDecision: verdict.decision,
      confidence: verdict.confidence,
      rationale: verdict.why,
    };
    if (verdict.decision === "delete") return { ...base, suggestedProjectAction: "none" };
    const project = verdict.project ?? null;
    const current = source.projectName ?? null;
    const suggestedProjectAction = project === null ? (current ? "manual-remove" : "none")
      : !current ? "use-or-create"
        : project === current ? "keep-current" : "manual-move";
    return {
      ...base,
      suggestedNewTitle: verdict.title ?? null,
      suggestedProjectAction,
      suggestedProjectName: project,
      ...(project ? { projectRationale: verdict.projectWhy || verdict.why } : {}),
    };
  });
  const proposal = {
    version: 1,
    kind: "classification-proposals",
    inventoryDigest: digest,
    scope: { candidateCount: items.length },
    items,
  };
  // 검증에 실패한 조각을 남기지 않도록 임시 파일에서 검증한 뒤 옮긴다.
  const output = resolve(outputPath);
  assert(!existsSync(output), `Output already exists: ${output}`);
  const staging = `${output}.partial-${process.pid}`;
  writeFileSync(staging, JSON.stringify(proposal, null, 2), { mode: 0o600, flag: "wx" });
  try {
    const validation = validateClassificationProposals(inventoryPath, staging);
    renameSync(staging, output);
    return { output, validation };
  } catch (error) {
    unlinkSync(staging);
    throw error;
  }
}

function option(values, name, fallback) {
  const index = values.indexOf(name);
  return index === -1 ? fallback : Number(values[index + 1]);
}

async function main(argv) {
  const [command, ...values] = argv;
  const usage = [
    "node overhaul.js slice <inventory.json> <outDir> --parts N [--seed S]",
    "node overhaul.js validate-cards <inventory.json> <cardsDir>",
    "node overhaul.js assemble <inventory.json> <verdictsDir> <proposal.json>",
  ].join("\n");
  let result;
  if (command === "slice" && values.length >= 2) {
    result = sliceInventory(values[0], values[1], { parts: option(values, "--parts", 0), seed: option(values, "--seed", 1) });
  } else if (command === "validate-cards" && values.length === 2) {
    result = validateCards(values[0], values[1]);
  } else if (command === "assemble" && values.length === 3) {
    result = assembleProposal(values[0], values[1], values[2]);
  } else {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
