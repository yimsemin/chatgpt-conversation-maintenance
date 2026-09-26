import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(port, ...args) {
  return spawnSync(process.execPath, [join(ROOT, "launcher.js"), ...args, "--no-open"], {
    cwd: ROOT, env: { ...process.env, MAINTENANCE_PORT: String(port) }, encoding: "utf8", timeout: 15000 });
}

async function startApp(port, cwd = ROOT) {
  const child = spawn(process.execPath, [join(ROOT, "launcher.js"), "--no-open"], {
    cwd, env: { ...process.env, MAINTENANCE_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const end = Date.now() + 15000;
  while (Date.now() < end && !output.includes("이 터미널 창이 앱입니다")) {
    if (child.exitCode !== null) throw new Error(`launcher exited: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(output.includes("이 터미널 창이 앱입니다"), output);
  return { child, output: () => output };
}

test("the app runs in the foreground process, shows what is running, and refuses a second copy", async () => {
  const port = 18711;
  const app = await startApp(port);
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(health.service, "chatgpt-conversation-maintenance");
    assert.equal(health.pid, app.child.pid, "the running server is the launcher process itself, not a hidden child");
    assert.equal(typeof health.startedAt, "string");
    assert.equal(health.codeChanged, false);
    assert.match(app.output(), new RegExp(`프로세스 ${app.child.pid}`));

    const second = run(port);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /이미 대화 정리 앱이 실행 중입니다/);
    assert.match(second.stderr, new RegExp(String(app.child.pid)));

    const status = run(port, "status");
    assert.match(status.stdout, new RegExp(`실행 중: 프로세스 ${app.child.pid}`));

    const stopped = run(port, "stop");
    assert.equal(stopped.status, 0, stopped.stderr);
    await once(app.child, "exit");
    assert.match(run(port, "status").stdout, /실행 중인 대화 정리 앱이 없습니다/);
  } finally { app.child.kill("SIGKILL"); }
});

test("closing the terminal window (SIGHUP) or pressing Ctrl+C ends the app", async () => {
  for (const [port, signal] of [[18712, "SIGHUP"], [18713, "SIGINT"]]) {
    const app = await startApp(port);
    app.child.kill(signal);
    const [code] = await once(app.child, "exit");
    assert.equal(code, 0, `${signal} ends the app cleanly`);
    assert.match(run(port, "status").stdout, /실행 중인 대화 정리 앱이 없습니다/);
  }
});

test("the app status flags code that changed after the process started", async () => {
  const { appStatus } = await import("../app-status.js");
  const root = mkdtempSync(join(tmpdir(), "app-status-"));
  try {
    writeFileSync(join(root, "old.js"), "");
    utimesSync(join(root, "old.js"), new Date("2020-01-01"), new Date("2020-01-01"));
    assert.equal(appStatus(root).codeChanged, false);
    writeFileSync(join(root, "new.js"), "");
    utimesSync(join(root, "new.js"), new Date(Date.now() + 60000), new Date(Date.now() + 60000));
    const status = appStatus(root);
    assert.equal(status.codeChanged, true);
    assert.equal(status.pid, process.pid);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("starting from another folder (double-click, a terminal elsewhere) still uses this repository as the work folder", async () => {
  const port = 18715;
  const app = await startApp(port, tmpdir());
  try {
    const config = await (await fetch(`http://127.0.0.1:${port}/config`)).json();
    assert.equal(realpathSync(config.workspace), realpathSync(ROOT));
    assert.equal(realpathSync(config.dataDir), realpathSync(join(ROOT, "data")));
  } finally { run(port, "stop"); app.child.kill("SIGKILL"); }
});
