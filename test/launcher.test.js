import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bodyLimitForPath } from "../src/server.js";
import { withTemp } from "./support/tmp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function withApp(port, check) {
  await withTemp("chatgpt-launcher-test-", async (root) => {
    const options = { cwd: root, env: { ...process.env, MAINTENANCE_ROOT: root, MAINTENANCE_PORT: String(port) } };
    const args = [join(ROOT, "src", "launcher.js"), "--no-open"];
    const run = (...commands) => spawnSync(process.execPath, [...args, ...commands], {
      ...options, encoding: "utf8", timeout: 15000,
    });
    const child = spawn(process.execPath, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise((resolve) => child.once("close", (...result) => resolve(result)));
    let output = "";
    let spawnError;
    child.on("error", (error) => { spawnError = error; });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    try {
      const end = Date.now() + 15000;
      while (Date.now() < end && !output.includes("이 터미널 창이 앱입니다")) {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`launcher exited: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(output.includes("이 터미널 창이 앱입니다"), output);
      await check({ child, closed, output, run, base: `http://127.0.0.1:${port}` });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  });
}

test("the launcher serves the app from another working directory and manages a single foreground process", async () => {
  await withApp(18711, async ({ child, closed, output, run, base }) => {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.service, "chatgpt-conversation-maintenance");
    assert.equal(health.pid, child.pid, "the running server is the launcher process itself, not a hidden child");
    assert.equal(typeof health.startedAt, "string");
    assert.equal(health.codeChanged, false);
    assert.match(output, new RegExp(`프로세스 ${child.pid}`));
    assert.equal((await fetch(`${base}/`)).status, 200);
    const session = await (await fetch(`${base}/maintenance/session`)).json();
    assert.equal(session.run, null, "the test instance uses an empty workspace");

    const second = run();
    assert.equal(second.status, 1);
    assert.match(second.stderr, /이미 대화 정리 앱이 실행 중입니다/);
    assert.match(second.stderr, new RegExp(String(child.pid)));

    const status = run("status");
    assert.match(status.stdout, new RegExp(`실행 중: 프로세스 ${child.pid}`));

    const stopped = run("stop");
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal((await closed)[0], 0);
    assert.match(run("status").stdout, /실행 중인 대화 정리 앱이 없습니다/);
  });
});

// Windows 는 SIGHUP·SIGINT 를 프로세스에 전달하지 못해(강제 종료) 이 시험은 POSIX 에서만 의미가 있다.
test("closing the terminal window (SIGHUP) or pressing Ctrl+C ends the app", { skip: process.platform === "win32" }, async () => {
  for (const [port, signal] of [[18712, "SIGHUP"], [18713, "SIGINT"]]) {
    await withApp(port, async ({ child, closed, run }) => {
      child.kill(signal);
      const [code] = await closed;
      assert.equal(code, 0, `${signal} ends the app cleanly`);
      assert.match(run("status").stdout, /실행 중인 대화 정리 앱이 없습니다/);
    });
  }
});

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
