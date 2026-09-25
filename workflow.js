#!/usr/bin/env node
// 분류·컴파일 단계의 로컬 명령(원격을 건드리지 않는다). 실제 로직은 classification-*.js·proposal-validation.js·decision-compile.js에 있다.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeClassificationReview, writeClaudePrompt } from "./classification-review.js";
import { validateClassificationProposals } from "./proposal-validation.js";
import { compileProjectRouting, compileReviewedDecisions, writeRemainingManifest } from "./decision-compile.js";

try { process.umask(0o077); } catch {}

function usage() {
  return [
    "Usage:",
    "  node workflow.js review <inventory.json> <review.json>",
    "  node workflow.js claude-prompt <review.json> <prompt.md> [<inventory.json> <proposal.json>]",
    "  node workflow.js validate-proposal <inventory.json> <proposal.json>",
    "  node workflow.js compile <inventory.json> <reviewed-decisions.json> <output-dir>",
    "  node workflow.js compile-routing <inventory.json> <reviewed-decisions.json> <routing.json>",
    "  node workflow.js remaining <manifest.json> <receipt.json> <remaining.json>",
  ].join("\n");
}

async function main(args) {
  const [command, ...values] = args;
  if (command === "review" && values.length === 2) {
    console.log(JSON.stringify(writeClassificationReview(...values), null, 2));
    return;
  }
  if (command === "claude-prompt" && (values.length === 2 || values.length === 4)) {
    const [reviewPath, outputPath, inventoryPath = "", proposalPath = ""] = values;
    console.log(JSON.stringify(
      writeClaudePrompt(reviewPath, outputPath, { inventoryPath, proposalPath }), null, 2));
    return;
  }
  if (command === "validate-proposal" && values.length === 2) {
    console.log(JSON.stringify(validateClassificationProposals(...values), null, 2));
    return;
  }
  if (command === "compile" && values.length === 3) {
    console.log(JSON.stringify(compileReviewedDecisions(...values), null, 2));
    return;
  }
  if (command === "compile-routing" && values.length === 3) {
    console.log(JSON.stringify(compileProjectRouting(...values), null, 2));
    return;
  }
  if (command === "remaining" && values.length === 3) {
    const manifest = writeRemainingManifest(...values);
    console.log(JSON.stringify({ output: resolve(values[2]), actions: manifest.actions.length }, null, 2));
    return;
  }
  throw new Error(usage());
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
