#!/usr/bin/env node
// 분류 단계의 로컬 명령(원격을 건드리지 않는다). 실제 로직은 classification-*.js·proposal-validation.js에 있다.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeClassificationReview, writeClaudePrompt } from "./classification-review.js";
import { validateClassificationProposals } from "./proposal-validation.js";

try { process.umask(0o077); } catch {}

function usage() {
  return [
    "Usage:",
    "  node src/workflow.js review <inventory.json> <review.json>",
    "  node src/workflow.js claude-prompt <review.json> <prompt.md> [<inventory.json> <proposal.json>]",
    "  node src/workflow.js validate-proposal <inventory.json> <proposal.json>",
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
  throw new Error(usage());
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
