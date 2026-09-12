#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assert } from "./assert.js";
import { resolveDataDir } from "./data-dir.js";
import { assertLockHeld } from "./maintenance-lock.js";
import { collectConversationCatalog } from "./maintenance-cli.js";
import {
  listOwnedProjects,
  prepareProjectPlacement,
  runProjectPlacementWorkflow,
  validateProjectPlacementPlan,
} from "./project-management.js";
import {
  prepareProjectRouting,
  projectRoutingStatus,
  runProjectRouting,
  validateProjectRouting,
} from "./project-routing.js";

try { process.umask(0o077); } catch {}

const MODULE_ROOT = dirname(fileURLToPath(import.meta.url));

function readPlan(path) {
  let input;
  try { input = JSON.parse(readFileSync(resolve(path), "utf8")); }
  catch { throw new Error(`Project placement plan is not valid JSON: ${resolve(path)}`); }
  return validateProjectPlacementPlan(input);
}

function readRouting(path) {
  let input;
  try { input = JSON.parse(readFileSync(resolve(path), "utf8")); }
  catch { throw new Error(`Project routing plan is not valid JSON: ${resolve(path)}`); }
  return validateProjectRouting(input);
}

function usage() {
  return [
    "Usage:",
    "  node project-cli.js prepare <plan.json>",
    "  node project-cli.js prepare-routing <routing.json>",
    "  node project-cli.js routing-status <routing.json>",
    "  원격 list/unassigned/apply/apply-routing 명령은 폐기되었습니다. 로컬 앱을 사용하세요.",
    "",
    "Remote options:",
    "  --data-dir <path>            Data folder holding the maintenance lock (default: <repo>/data)",
    "  --account-id <uuid>          Override the account ID from the session JSON/JWT",
    "  --request-delay-seconds <n>  Wait after each completed HTTP request",
    "  --max-targets <number>        Stop a routing run after this many target projects",
    "  --start-target <zero-based>    Start a routing run at this target index",
    "  --pending-only                 Skip targets proven complete by matching receipts",
    "",
    "List and unassigned are read-only. Apply creates a project only when explicitly approved in the plan,",
    "moves only explicitly approved projectless conversations, and writes a token-free receipt.",
    "Pipe session JSON from a local clipboard command. Authentication is memory-only.",
  ].join("\n");
}

function parseRemoteOptions(values, { requiresPlan = false, allowsMaxTargets = false } = {}) {
  let index = 0;
  let planPath = "";
  if (requiresPlan) {
    assert(values.length >= 1, usage());
    planPath = values[index++];
  }
  let confirmation = "";
  let accountId = "";
  let dataDir = "";
  let requestDelayMs = requiresPlan ? 2000 : 0;
  let maxTargets = Number.POSITIVE_INFINITY;
  let startTarget = 0;
  let pendingOnly = false;
  while (index < values.length) {
    const option = values[index++];
    if (option === "--pending-only" && allowsMaxTargets) {
      pendingOnly = true;
      continue;
    }
    const value = values[index++];
    assert(value !== undefined, `Missing value for ${option}`);
    if (option === "--confirmation" && requiresPlan) confirmation = value;
    else if (option === "--account-id") accountId = value;
    else if (option === "--data-dir") dataDir = value;
    else if (option === "--request-delay-seconds") {
      const seconds = Number(value);
      assert(Number.isFinite(seconds) && seconds >= 0, "--request-delay-seconds must be non-negative");
      requestDelayMs = Math.round(seconds * 1000);
    } else if (option === "--max-targets" && allowsMaxTargets) {
      maxTargets = Number(value);
      assert(Number.isInteger(maxTargets) && maxTargets > 0, "--max-targets must be a positive integer");
    } else if (option === "--start-target" && allowsMaxTargets) {
      startTarget = Number(value);
      assert(Number.isInteger(startTarget) && startTarget >= 0,
        "--start-target must be a non-negative integer");
    } else throw new Error(`Unknown option: ${option}\n${usage()}`);
  }
  return { planPath, confirmation, accountId, dataDir, requestDelayMs, maxTargets, startTarget, pendingOnly };
}

export async function listUnassignedConversations(api) {
  const catalog = await collectConversationCatalog(api);
  return catalog.conversations
    .filter((conversation) => conversation.projectName === null)
    .map((conversation) => ({
      conversationId: conversation.conversationId,
      title: conversation.title,
      isArchived: conversation.isArchived,
      createTime: conversation.createTime,
      updateTime: conversation.updateTime,
    }));
}

async function main(args) {
  const [command, ...values] = args;
  if (command === "prepare" && values.length === 1) {
    console.log(JSON.stringify(prepareProjectPlacement(readPlan(values[0])), null, 2));
    return;
  }
  if (command === "prepare-routing" && values.length === 1) {
    console.log(JSON.stringify(prepareProjectRouting(readRouting(values[0])), null, 2));
    return;
  }
  if (command === "routing-status" && values.length === 1) {
    console.log(JSON.stringify(projectRoutingStatus(readRouting(values[0])), null, 2));
    return;
  }
  if (["list", "unassigned", "apply", "apply-routing"].includes(command)) {
    throw new Error("원격 프로젝트 CLI는 폐기되었습니다. 로컬 앱을 사용하세요.");
  }
  if (command === "list") {
    const options = parseRemoteOptions(values);
    const credentials = parseSessionJson(await readSession(), options.accountId);
    const api = createApi(credentials, options.requestDelayMs);
    const projects = await listOwnedProjects(api);
    console.log(JSON.stringify({ projects, requestMetrics: api.metrics }, null, 2));
    return;
  }
  if (command === "unassigned") {
    const options = parseRemoteOptions(values);
    const credentials = parseSessionJson(await readSession(), options.accountId);
    const api = createApi(credentials, options.requestDelayMs);
    const conversations = await listUnassignedConversations(api);
    console.log(JSON.stringify({ conversations, count: conversations.length, requestMetrics: api.metrics }, null, 2));
    return;
  }
  if (command === "apply") {
    const options = parseRemoteOptions(values, { requiresPlan: true });
    const plan = readPlan(options.planPath);
    const prepared = prepareProjectPlacement(plan);
    assert(options.confirmation,
      `--confirmation is required. Expected: ${prepared.expectedConfirmation}`);
    assertLockHeld({ dataDir: resolveDataDir({ dataDir: options.dataDir, appRoot: MODULE_ROOT }) });
    const credentials = parseSessionJson(await readSession(), options.accountId);
    const api = createApi(credentials, options.requestDelayMs);
    const result = await runProjectPlacementWorkflow({
      plan,
      accountId: credentials.accountId,
      confirmation: options.confirmation,
      reviewedConversationIds: plan.actions.map((action) => action.conversationId),
      api,
    });
    console.log(JSON.stringify({ ...result, requestMetrics: api.metrics }, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "apply-routing") {
    const options = parseRemoteOptions(values, { requiresPlan: true, allowsMaxTargets: true });
    const routing = readRouting(options.planPath);
    const prepared = prepareProjectRouting(routing);
    assert(options.confirmation,
      `--confirmation is required. Expected: ${prepared.expectedConfirmation}`);
    assertLockHeld({ dataDir: resolveDataDir({ dataDir: options.dataDir, appRoot: MODULE_ROOT }) });
    const credentials = parseSessionJson(await readSession(), options.accountId);
    const api = createApi(credentials, options.requestDelayMs);
    const result = await runProjectRouting({
      routing,
      confirmation: options.confirmation,
      accountId: credentials.accountId,
      api,
      startTarget: options.startTarget,
      maxTargets: options.maxTargets,
      pendingOnly: options.pendingOnly,
      onProgress: (event) => console.error(JSON.stringify(event)),
    });
    console.log(JSON.stringify({ ...result, requestMetrics: api.metrics }, null, 2));
    if (!result.ok) process.exitCode = 1;
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
