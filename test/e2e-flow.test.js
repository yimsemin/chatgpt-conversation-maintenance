// 서버를 자식 프로세스로 띄우고(모의 ChatGPT 연결) 화면이 쓰는 API로 스캔 → 제안 → 검토 → 적용 → 결과를 끝까지 돌린다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function startDev(port, extraArgs = [], env = {}) {
  const child = spawn(process.execPath, [join(ROOT, "dev", "fake-server.js"), ...extraArgs], {
    cwd: ROOT, env: { ...process.env, MAINTENANCE_PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dev server did not start: ${output}`)), 20000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("이 터미널 창이 앱입니다")) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("exit", (code) => reject(new Error(`dev server exited ${code}: ${output}`)));
  });
  // 시작에 실패해도 자식 프로세스를 남기지 않는다(남으면 다음 시험이 같은 포트에서 막힌다).
  try { await ready; } catch (error) { child.kill("SIGKILL"); throw error; }
  const base = `http://127.0.0.1:${port}`;
  const call = async (path, body = null) => {
    const response = await fetch(`${base}${path}`, body === null ? {} : {
      method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`);
    return data;
  };
  const get = (path) => call(path);
  const waitJob = async (jobId, timeoutMs = 60000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const job = await call(`/maintenance/job/${jobId}`);
      if (job.done) return job;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("job timed out");
  };
  return { base, call, get, waitJob, stop: async () => { child.kill("SIGTERM"); await once(child, "exit").catch(() => {}); } };
}

// 서버를 띄워 fn(dev)에 주고, 끝나면(실패해도) 끈다.
async function withDev(port, extraArgs, env, fn) {
  const dev = await startDev(port, extraArgs, env);
  try { return await fn(dev); } finally { await dev.stop(); }
}

async function untilProposal(dev) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const session = await dev.get("/maintenance/session");
    if (session.step === "review") return session;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("proposal did not appear");
}

const UNASSIGNED = { scope: { kind: "unassigned" } };
const isStandard = (title) => { const parts = String(title).split(" — "); return parts.length === 2 && parts.every((p) => p && p === p.trim() && !p.includes("—")); };

// 시험마다 서버와 포트가 따로라 서로 닿지 않는다. 나란히 돌려 전체 시간을 가장 느린 시험 하나로 줄인다.
describe("end to end against the fake ChatGPT", { concurrency: true }, () => {
test("unassigned conversations can be reviewed and applied through an automatic 429 recovery", async () => {
  await withDev(18601, ["--inject=patchConversation:429:12"], {
    MAINTENANCE_RESUME_WAIT_SECONDS: "1", MAINTENANCE_REQUEST_DELAY_MS: "0", MAINTENANCE_RELAY_BACKOFF_MS: "10",
  }, async (dev) => {
    let session = await dev.get("/maintenance/session");
    assert.equal(session.relay.connected, true);
    assert.equal(session.step, "scan");

    const scanned = await dev.waitJob((await dev.call("/maintenance/scan", UNASSIGNED)).jobId);
    assert.equal(scanned.ok, true, JSON.stringify(scanned.error));
    session = await untilProposal(dev);
    // 프로젝트에 넣지 않은 대화: 처음부터 프로젝트 없던 8개와 새로 생긴 6개.
    assert.equal(session.run.candidates, 14);
    assert.equal(session.knownProjects.projects.length, 0, "a projectless scan does not read the project list");

    const proposal = await dev.get("/maintenance/proposal");
    assert.equal(proposal.ready, true);
    const applied = await dev.waitJob((await dev.call("/maintenance/apply", { confirmDeletes: true })).jobId, 180000);
    assert.equal(applied.ok, true, JSON.stringify(applied.error));
    assert.ok(applied.events.some(({ stage, message }) => stage === "rate-limit" && message.includes("자동으로 이어서 진행합니다")),
      "the apply job must reach workflow recovery after request retries are exhausted");

    // 요청이 다른 작업 폴더를 가리킬 수 없다.
    const { base } = dev;
    assert.equal((await fetch(`${base}/maintenance/session?workspace=/tmp`)).status, 400);
    assert.equal((await fetch(`${base}/maintenance/scan`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ ...UNASSIGNED, workspace: "/tmp" }) })).status, 400);

    session = await dev.get("/maintenance/session");
    assert.equal(session.step, "result");
    const report = (await dev.get("/maintenance/report")).report;
    assert.deepEqual(report.mismatches, []);
    assert.ok(report.totals.delete >= 1);
    assert.equal(report.totals.candidates, 14);
    assert.ok(report.renameOrder.renamed > 1, "several titles were standardized");
    assert.equal(report.renameOrder.preserved, true, "renamed conversations keep their original relative order");
    const jobs = await dev.get("/maintenance/jobs");
    assert.ok(jobs.recent.length >= 2);
    assert.equal(jobs.recent.every((job) => job.done), true);

    // 최근 작업 기록 지우기: 이 컴퓨터의 작업 로그만 지우고 정리 결과는 그대로다.
    const cleared = await dev.call("/maintenance/jobs/clear", {});
    assert.ok(cleared.removed >= 2);
    assert.deepEqual((await dev.get("/maintenance/jobs")).recent, []);
    assert.deepEqual((await dev.get("/maintenance/report")).report, report, "clearing jobs preserves the report");
  });
});

test("the project picker and scoped scan expose the selected project and its exact candidate count", async () => {
  await withDev(18608, [], { MAINTENANCE_REQUEST_DELAY_MS: "0" }, async (dev) => {
    const listed = await dev.waitJob((await dev.call("/maintenance/projects", {})).jobId);
    assert.equal(listed.ok, true, JSON.stringify(listed.error));
    const name = "업무 프로젝트";
    assert.ok((await dev.get("/maintenance/session")).knownProjects.projects.some((project) => project.name === name));
    const project = await dev.waitJob((await dev.call("/maintenance/scan", { scope: { kind: "project", projectNames: [name] } })).jobId);
    assert.equal(project.ok, true, JSON.stringify(project.error));
    const session = await untilProposal(dev);
    assert.equal(session.run.candidates, 11);
    const catalog = await dev.get("/maintenance/catalog");
    assert.equal(catalog.conversations.length, 11);
    assert.ok(catalog.conversations.every((item) => item.projectName === name));
    const knownCounts = catalog.projects.filter((item) => item.conversationCount !== null);
    assert.deepEqual(knownCounts, [{ projectName: name, conversationCount: 11 }]);
  });
});

test("a relay window that is replaced mid-scan is recovered from automatically", async () => {
  await withDev(18606, ["--drop-relay-after=5"], { MAINTENANCE_RESUME_WAIT_SECONDS: "1", MAINTENANCE_REQUEST_DELAY_MS: "0" }, async (dev) => {
    const scanned = await dev.waitJob((await dev.call("/maintenance/scan", UNASSIGNED)).jobId, 120000);
    assert.equal(scanned.ok, true, JSON.stringify(scanned.error));
    assert.ok(scanned.events.some(({ stage }) => stage === "retry" || stage === "relay-down"),
      "the scan must encounter a connection interruption before completing");
    await untilProposal(dev);
  });
});

test("a second job is refused while one runs, and a cancelled scan can be started again", async () => {
  await withDev(18607, ["--slow"], { MAINTENANCE_REQUEST_DELAY_MS: "0" }, async (dev) => {
    const first = await dev.call("/maintenance/scan", UNASSIGNED);
    await assert.rejects(() => dev.call("/maintenance/scan", UNASSIGNED), /이미 다른 작업이 진행 중/);
    await dev.call("/maintenance/cancel", { jobId: first.jobId });
    const cancelled = await dev.waitJob(first.jobId, 60000);
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.cancelled, true);
    const again = await dev.waitJob((await dev.call("/maintenance/scan", UNASSIGNED)).jobId, 120000);
    assert.equal(again.ok, true, JSON.stringify(again.error));
  });
});

test("delete candidates move to the trash project with standard titles and are later confirmed or restored", async () => {
  await withDev(18603, [], { MAINTENANCE_REQUEST_DELAY_MS: "0" }, async (dev) => {
    const scanned = await dev.waitJob((await dev.call("/maintenance/scan", UNASSIGNED)).jobId);
    assert.equal(scanned.ok, true, JSON.stringify(scanned.error));
    await untilProposal(dev);
    const proposal = await dev.get("/maintenance/proposal");
    const trashed = proposal.items.filter((item) => item.suggestedDecision === "delete");
    assert.ok(trashed.length >= 1);
    const decisions = proposal.items.map((item, index) => {
      if (item.suggestedDecision === "delete") {
        // 삭제후보 프로젝트로 옮기는 대화도 표준 제목이어야 한다.
        const newTitle = item.suggestedNewTitle || (isStandard(item.currentTitle) ? undefined : `삭제후보 ${index} — 확인 대기`);
        return { conversationId: item.conversationId, decision: "keep", ...(newTitle ? { newTitle } : {}), projectName: "삭제후보", trashed: true };
      }
      return { conversationId: item.conversationId, decision: "keep", newTitle: item.suggestedNewTitle || item.currentTitle, projectName: item.suggestedProjectName || "" };
    });
    await dev.call("/maintenance/decisions", { decisions, trash: {
      project: "삭제후보", entries: trashed.map((item) => ({ conversationId: item.conversationId, reason: "저가치", intendedTarget: null })) } });
    const applied = await dev.waitJob((await dev.call("/maintenance/apply", { confirmDeletes: false })).jobId, 90000);
    assert.equal(applied.ok, true, JSON.stringify(applied.error));

    let session = await dev.get("/maintenance/session");
    assert.equal(session.trash.project, "삭제후보");
    assert.equal(session.trash.count, trashed.length);
    assert.equal(session.trash.oldestDays, 0);
    const listing = await dev.get("/maintenance/trash");
    assert.equal(listing.items.length, trashed.length);
    assert.equal(listing.items.every((item) => isStandard(item.title)), true);

    // ChatGPT에서 그대로인 대화는 다시 확인해도 목록에 남는다(읽기 전용).
    const synced = await dev.waitJob((await dev.call("/maintenance/trash/sync", {})).jobId);
    assert.equal(synced.ok, true, JSON.stringify(synced.error));
    assert.equal(synced.result.trashSync.released, 0);

    // 하나는 삭제 확정, 나머지는 원래 자리로.
    const [toDelete, ...toKeep] = listing.items;
    const followUp = [{ conversationId: toDelete.conversationId, decision: "delete" },
      ...toKeep.map((item) => ({ conversationId: item.conversationId, decision: "keep", projectName: "취미" }))];
    const prepared = await dev.call("/maintenance/trash/prepare", { decisions: followUp });
    assert.equal(prepared.deletes, 1);
    session = await dev.get("/maintenance/session");
    assert.equal(session.step, "apply");
    const unconfirmed = await dev.waitJob((await dev.call("/maintenance/apply", {})).jobId);
    assert.equal(unconfirmed.ok, false);
    assert.match(unconfirmed.error.message, /별도 확인이 필요합니다/);
    assert.deepEqual(await dev.get("/maintenance/trash"), listing);
    const second = await dev.waitJob((await dev.call("/maintenance/apply", { confirmDeletes: true })).jobId, 90000);
    assert.equal(second.ok, true, JSON.stringify(second.error));
    session = await dev.get("/maintenance/session");
    assert.equal(session.trash.count, 0);
    const report = (await dev.get("/maintenance/report")).report;
    assert.deepEqual(report.mismatches, []);
    assert.equal(report.totals.delete, 1);
  });
});

test("when a title changes after review, apply stops with a rescan recovery and a new scan picks it up again", async () => {
  await withDev(18605, ["--rename-after-proposal"], { MAINTENANCE_REQUEST_DELAY_MS: "0", MAINTENANCE_RELAY_BACKOFF_MS: "10" }, async (dev) => {
    await dev.waitJob((await dev.call("/maintenance/scan", UNASSIGNED)).jobId);
    await untilProposal(dev);
    const failed = await dev.waitJob((await dev.call("/maintenance/apply", { confirmDeletes: true })).jobId, 60000);
    assert.equal(failed.ok, false);
    assert.equal(failed.error.explain.recovery, "rescan");
    assert.match(failed.error.explain.title, /제목이 바뀌어/);
    let session = await dev.get("/maintenance/session");
    assert.equal(session.recentJobs[0].error.explain.recovery, "rescan");

    // 이미 적용된 부분은 남고, 같은 범위를 다시 수집하면 남은 대화가 다시 후보가 된다.
    const again = await dev.waitJob((await dev.call("/maintenance/scan", UNASSIGNED)).jobId);
    assert.equal(again.ok, true, JSON.stringify(again.error));
    session = await dev.get("/maintenance/session");
    assert.ok(session.run.candidates >= 1);
  });
});
});
