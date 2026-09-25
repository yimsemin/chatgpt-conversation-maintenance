// 서버를 자식 프로세스로 띄우고(모의 ChatGPT 연결) 화면이 쓰는 API로 스캔 → 제안 → 검토 → 적용 → 결과를 끝까지 돌린다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function startDev(port, extraArgs = [], env = {}) {
  const child = spawn(process.execPath, [join(ROOT, "dev", "fake-server.js"), ...extraArgs], {
    cwd: ROOT, env: { ...process.env, MAINTENANCE_PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let workspace = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dev server did not start: ${output}`)), 20000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/작업 폴더 (.+)\n/);
      if (match && output.includes("종료하려면")) { workspace = match[1].trim(); clearTimeout(timer); resolve(); }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("exit", (code) => reject(new Error(`dev server exited ${code}: ${output}`)));
  });
  await ready;
  const base = `http://127.0.0.1:${port}`;
  const call = async (path, body = null) => {
    const response = await fetch(`${base}${path}`, body === null ? {} : {
      method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ workspace, ...body }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `HTTP ${response.status}`);
    return data;
  };
  const get = (path) => call(`${path}${path.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(workspace)}`);
  const waitJob = async (jobId, timeoutMs = 60000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const job = await call(`/maintenance/job/${jobId}`);
      if (job.done) return job;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("job timed out");
  };
  return { child, call, get, waitJob, workspace, stop: async () => { child.kill("SIGTERM"); await once(child, "exit").catch(() => {}); } };
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

test("scan, review and apply run end to end against the fake ChatGPT", async () => {
  const dev = await startDev(18601, [], { MAINTENANCE_REQUEST_DELAY_MS: "0" });
  try {
    let session = await dev.get("/maintenance/session");
    assert.equal(session.relay.connected, true);
    assert.equal(session.step, "scan");
    assert.equal(session.baseline.counts.conversations, 60);

    const scan = await dev.call("/maintenance/scan", {});
    const scanned = await dev.waitJob(scan.jobId);
    assert.equal(scanned.ok, true, JSON.stringify(scanned.error));
    session = await untilProposal(dev);
    assert.equal(session.run.candidates, 6);

    const summary = (await dev.get("/maintenance/summary")).summary;
    assert.equal(summary.totals.candidates, 6);
    assert.ok(summary.totals.delete >= 1);

    const proposal = await dev.get("/maintenance/proposal");
    assert.equal(proposal.ready, true);
    const apply = await dev.call("/maintenance/apply", { confirmDeletes: true, quiet: true });
    const applied = await dev.waitJob(apply.jobId, 90000);
    assert.equal(applied.ok, true, JSON.stringify(applied.error));

    session = await dev.get("/maintenance/session");
    assert.equal(session.step, "result");
    const report = (await dev.get("/maintenance/report")).report;
    assert.deepEqual(report.mismatches, []);
    assert.equal(report.verification, "assume-quiet");
    assert.equal(report.totals.delete, summary.totals.delete);
    const jobs = await dev.get("/maintenance/jobs");
    assert.ok(jobs.recent.length >= 2);
    assert.equal(jobs.recent.every((job) => job.done), true);

    // 기준선 확정: 하네스가 기준선 이후 만든 새 대화는 넣지 않고 후보로 남긴다(적용을 거친 뒤라 모두 반영되어 있어야 한다).
    const rebase = await dev.waitJob((await dev.call("/maintenance/rebaseline", {})).jobId);
    assert.equal(rebase.ok, true, JSON.stringify(rebase.error));
    // 빠른 검증으로 만든 기준선이 실제 계정과 정확히 같다는 뜻이다(이동·제목·삭제 차이 0).
    assert.deepEqual([rebase.result.rebaseline.removed, rebase.result.rebaseline.moved, rebase.result.rebaseline.renamed], [0, 0, 0]);
    session = await dev.get("/maintenance/session");
    assert.ok(session.lastRebaseline);
    assert.equal(session.baseline.verification, "full");

    // 확정한 기준선으로 다시 확인하면 어긋나는 후보가 없어야 한다. 결과 보고서 뒤에 끝난 확인이라 결과 화면으로 되돌아가지 않는다.
    const again = await dev.waitJob((await dev.call("/maintenance/scan", {})).jobId);
    assert.equal(again.ok, true, JSON.stringify(again.error));
    assert.ok(again.events.some((event) => /새 대화 확인/.test(event.message)));
    session = await dev.get("/maintenance/session");
    assert.equal(session.run.candidates, 0);
    assert.equal(session.step, "scan", "a read-only check after the result must not bring the old result screen back");
  } finally { await dev.stop(); }
});

test("a burst of 429 during apply is waited out and the run still finishes on its own", async () => {
  const dev = await startDev(18602, ["--inject=patchConversation:429:12"], { MAINTENANCE_RESUME_WAIT_SECONDS: "1", MAINTENANCE_REQUEST_DELAY_MS: "0", MAINTENANCE_RELAY_BACKOFF_MS: "10" });
  try {
    const scanned = await dev.waitJob((await dev.call("/maintenance/scan", {})).jobId);
    assert.equal(scanned.ok, true, JSON.stringify(scanned.error));
    await untilProposal(dev);
    const apply = await dev.call("/maintenance/apply", { confirmDeletes: true, quiet: true });
    const applied = await dev.waitJob(apply.jobId, 180000);
    assert.equal(applied.ok, true, JSON.stringify(applied.error));
    assert.ok(applied.events.some((event) => event.stage === "rate-limit" || event.stage === "retry"),
      "the 429 wait should be visible in the log");
  } finally { await dev.stop(); }
});

test("a relay window that is replaced mid-scan is recovered from automatically", async () => {
  const dev = await startDev(18606, ["--drop-relay-after=5"], { MAINTENANCE_RESUME_WAIT_SECONDS: "1", MAINTENANCE_REQUEST_DELAY_MS: "0" });
  try {
    const scanned = await dev.waitJob((await dev.call("/maintenance/scan", {})).jobId, 120000);
    assert.equal(scanned.ok, true, JSON.stringify(scanned.error));
    await untilProposal(dev);
  } finally { await dev.stop(); }
});

test("a second job is refused while one runs, and a cancelled scan can be started again", async () => {
  const dev = await startDev(18607, ["--slow"], { MAINTENANCE_REQUEST_DELAY_MS: "0" });
  try {
    const first = await dev.call("/maintenance/scan", {});
    await assert.rejects(() => dev.call("/maintenance/scan", {}));
    await dev.call("/maintenance/cancel", { jobId: first.jobId });
    const cancelled = await dev.waitJob(first.jobId, 60000);
    assert.equal(cancelled.ok, false);
    const again = await dev.waitJob((await dev.call("/maintenance/scan", {})).jobId, 120000);
    assert.equal(again.ok, true, JSON.stringify(again.error));
  } finally { await dev.stop(); }
});

test("delete candidates can be parked in a project and later confirmed or restored", async () => {
  const dev = await startDev(18603, [], { MAINTENANCE_REQUEST_DELAY_MS: "0" });
  try {
    const scanned = await dev.waitJob((await dev.call("/maintenance/scan", {})).jobId);
    assert.equal(scanned.ok, true, JSON.stringify(scanned.error));
    await untilProposal(dev);
    const proposal = await dev.get("/maintenance/proposal");
    const isStandard = (title) => { const parts = title.split(" — "); return parts.length === 2 && parts.every((p) => p && p === p.trim() && !p.includes("—")); };
    const parked = proposal.items.filter((item) => item.suggestedDecision === "delete");
    assert.ok(parked.length >= 1);
    const decisions = proposal.items.map((item) => {
      if (item.suggestedDecision === "delete") {
        return { conversationId: item.conversationId, decision: "keep", projectName: "임시 보관", parked: true };
      }
      return { conversationId: item.conversationId, decision: "keep", newTitle: item.suggestedNewTitle || item.currentTitle, projectName: item.suggestedProjectName || "" };
    });
    await dev.call("/maintenance/decisions", { decisions, parking: {
      project: "임시 보관", entries: parked.map((item) => ({ conversationId: item.conversationId, reason: "저가치", intendedTarget: null })) } });
    const applied = await dev.waitJob((await dev.call("/maintenance/apply", { confirmDeletes: false, quiet: true })).jobId, 90000);
    assert.equal(applied.ok, true, JSON.stringify(applied.error));

    let session = await dev.get("/maintenance/session");
    assert.equal(session.parking.project, "임시 보관");
    assert.equal(session.parking.count, parked.length);
    const listing = await dev.get("/maintenance/parking");
    assert.equal(listing.items.length, parked.length);
    assert.equal(listing.items.every((item) => item.inBaseline), true);

    // 하나는 삭제 확정, 나머지는 원래 자리로. 남길 대화의 제목이 표준이 아니면 새 제목을 준다.
    const [toDelete, ...toKeep] = listing.items;
    const followUp = [{ conversationId: toDelete.conversationId, decision: "delete" },
      ...toKeep.map((item) => ({ conversationId: item.conversationId, decision: "keep", projectName: "오디오",
        newTitle: isStandard(item.title) ? undefined : "복원한 대화 — 다시 정리한 제목" }))];
    const prepared = await dev.call("/maintenance/parking/prepare", { decisions: followUp });
    assert.equal(prepared.deletes, 1);
    session = await dev.get("/maintenance/session");
    assert.equal(session.step, "apply");
    const second = await dev.waitJob((await dev.call("/maintenance/apply", { confirmDeletes: true, quiet: true })).jobId, 90000);
    assert.equal(second.ok, true, JSON.stringify(second.error));
    session = await dev.get("/maintenance/session");
    assert.equal(session.parking.count, 0);
    const report = (await dev.get("/maintenance/report")).report;
    assert.deepEqual(report.mismatches, []);
    assert.equal(report.totals.delete, 1);
  } finally { await dev.stop(); }
});

test("a first run without a baseline starts in setup and creates one on request", async () => {
  const dev = await startDev(18604, ["--no-baseline"], { MAINTENANCE_REQUEST_DELAY_MS: "0" });
  try {
    let session = await dev.get("/maintenance/session");
    assert.equal(session.step, "setup");
    assert.equal(session.baseline, null);
    const made = await dev.waitJob((await dev.call("/maintenance/baseline", { mode: "accept" })).jobId);
    assert.equal(made.ok, true, JSON.stringify(made.error));
    assert.equal(made.result.baseline.conversations, 66);
    session = await dev.get("/maintenance/session");
    assert.equal(session.step, "scan");
    assert.equal(session.baseline.counts.conversations, 66);
    await assert.rejects(dev.call("/maintenance/baseline", { mode: "accept" }), /이미 기록이 있습니다/);
  } finally { await dev.stop(); }
});

test("when a title changes after review, apply stops with a rescan recovery and a new scan picks it up again", async () => {
  const dev = await startDev(18605, ["--rename-after-proposal"], { MAINTENANCE_REQUEST_DELAY_MS: "0", MAINTENANCE_RELAY_BACKOFF_MS: "10" });
  try {
    await dev.waitJob((await dev.call("/maintenance/scan", {})).jobId);
    await untilProposal(dev);
    const failed = await dev.waitJob((await dev.call("/maintenance/apply", { confirmDeletes: true, quiet: true })).jobId, 60000);
    assert.equal(failed.ok, false);
    assert.equal(failed.error.explain.recovery, "rescan");
    assert.match(failed.error.explain.title, /제목이 바뀌어/);
    let session = await dev.get("/maintenance/session");
    assert.equal(session.recentJobs[0].error.explain.recovery, "rescan");

    // 이미 적용된 부분은 남고, 새 확인이 남은 대화를 다시 후보로 만든다.
    const again = await dev.waitJob((await dev.call("/maintenance/scan", {})).jobId);
    assert.equal(again.ok, true, JSON.stringify(again.error));
    session = await dev.get("/maintenance/session");
    assert.ok(session.run.candidates >= 1);
  } finally { await dev.stop(); }
});
