import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function run(port, ...args) {
  return spawnSync(process.execPath, [join(ROOT, "src", "launcher.js"), ...args, "--no-open"], {
    cwd: ROOT, env: { ...process.env, MAINTENANCE_PORT: String(port) }, encoding: "utf8", timeout: 15000 });
}

async function startApp(port, cwd = ROOT) {
  const child = spawn(process.execPath, [join(ROOT, "src", "launcher.js"), "--no-open"], {
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

// Windows 는 SIGHUP·SIGINT 를 프로세스에 전달하지 못해(강제 종료) 이 시험은 POSIX 에서만 의미가 있다.
test("closing the terminal window (SIGHUP) or pressing Ctrl+C ends the app", { skip: process.platform === "win32" }, async () => {
  for (const [port, signal] of [[18712, "SIGHUP"], [18713, "SIGINT"]]) {
    const app = await startApp(port);
    app.child.kill(signal);
    const [code] = await once(app.child, "exit");
    assert.equal(code, 0, `${signal} ends the app cleanly`);
    assert.match(run(port, "status").stdout, /실행 중인 대화 정리 앱이 없습니다/);
  }
});

test("the app status flags code that changed after the process started", async () => {
  const { appStatus } = await import("../src/app-status.js");
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

test("starting from another folder (double-click, a terminal elsewhere) still serves the screen and works on this repository", async () => {
  const port = 18715;
  const app = await startApp(port, tmpdir());
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/maintenance/session`)).status, 200);
  } finally { run(port, "stop"); app.child.kill("SIGKILL"); }
});

import { bodyLimitForPath } from "../src/server.js";

// 릴레이 결과에는 대화 본문 전체가 실린다. 2MB 한도로는 실제 대화가 거부되고,
// 결과가 브로커에 도달하지 못해 스캔이 "relay timed out"으로 실패했다(2026-09-12 실측).
test("relay results may carry a whole conversation while other bodies stay small", () => {
  const relay = bodyLimitForPath("/relay/result");
  const other = bodyLimitForPath("/maintenance/decisions");
  assert.ok(relay >= 32 * 1024 * 1024, "릴레이 결과 한도가 대화 본문에 부족합니다");
  assert.equal(other, 2 * 1024 * 1024);
  assert.equal(bodyLimitForPath("/relay/next"), other);
  assert.equal(bodyLimitForPath("/auth/session"), other);
});
