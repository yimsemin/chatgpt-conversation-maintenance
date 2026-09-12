#!/usr/bin/env node

import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const URL = "http://127.0.0.1:8523/";
const HEALTH_URL = `${URL}health`;

function assertSupportedNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 24) {
    throw new Error(`Node.js 24 이상이 필요합니다. 현재 버전: ${process.version}`);
  }
}

async function isMaintenanceServerRunning() {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(700), cache: "no-store" });
    const body = await response.json();
    return response.ok && body?.service === "chatgpt-conversation-maintenance";
  } catch { return false; }
}

function openBrowser() {
  try {
    if (process.platform === "win32") spawn("explorer.exe", [URL], { detached: true, stdio: "ignore" }).unref();
    else if (process.platform === "darwin") spawn("open", [URL], { detached: true, stdio: "ignore" }).unref();
    else spawn("xdg-open", [URL], { detached: true, stdio: "ignore" }).unref();
  } catch {
    console.log(`브라우저에서 ${URL} 을 여세요.`);
  }
}

async function waitUntilReady(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isMaintenanceServerRunning()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function main() {
  assertSupportedNode();
  if (!await isMaintenanceServerRunning()) {
    const localDir = join(ROOT, ".local");
    mkdirSync(localDir, { recursive: true, mode: 0o700 });
    const logFd = openSync(join(localDir, "maintenance-web.log"), "a", 0o600);
    const child = spawn(process.execPath, [join(ROOT, "server.js"), "--no-open"], {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    closeSync(logFd);
    if (!await waitUntilReady()) {
      throw new Error(`로컬 웹앱을 시작하지 못했습니다. ${join(localDir, "maintenance-web.log")}를 확인하세요.`);
    }
  }
  openBrowser();
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
