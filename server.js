#!/usr/bin/env node
/**
 * 로컬 대화 유지관리 웹앱 서버.
 *
 * `127.0.0.1:8523`에서만 동작하며 외부에 배포되지 않는다. 화면(`public/app.html`)을
 * 서빙하고, 유지관리 워크플로 API(`/maintenance/*`, maintenance-web.js)를 위임한다.
 * 비공개 ChatGPT API 호출은 이 파일에 없다. chatgpt.com 페이지의 릴레이 실행기가 수행한다.
 */

import { createServer } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { handleMaintenanceWebRequest } from "./maintenance-web.js";
import { CONFIG } from "./config.js";
import { DEFAULT_TRASH_PROJECT, configuredTrash } from "./data-dir.js";
import { handleRemoteRelayRequest } from "./remote-relay.js";
import { APP_RELEASE, RELAY_PROTOCOL_VERSION } from "./app-version.js";
import { appStatus } from "./app-status.js";
import { jobs } from "./web-jobs.js";
import { MAX_BODY_BYTES, appFolders, jsonResponse, readRequestJson } from "./web-common.js";

// 새로 만드는 파일·디렉터리를 현재 OS 사용자로 제한한다(플랫폼이 umask를 지원하는 경우).
try { process.umask(0o077); } catch {}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const NO_OPEN = process.argv.includes("--no-open");

const HOST = "127.0.0.1";
const PORT = CONFIG.port;

const STRICT_CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

// 화면이 쓰는 정적 자원. 파일 이름은 고정 목록/패턴만 허용하고 경로 이동은 받지 않는다.
const ASSET_TYPES = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const SHARED_MODULES = new Set(["summary.js", "title-rules.js", "project-link.js"]);

function serveAsset(res, pathname) {
  const match = pathname.match(/^\/assets\/(shared\/)?([a-z0-9-]+\.(?:js|css))$/);
  if (!match || (match[1] && !SHARED_MODULES.has(match[2]))) {
    res.writeHead(404); res.end(); return;
  }
  const base = match[1] ? [MODULE_DIR, match[2]] : [MODULE_DIR, "public", "assets", match[2]];
  const type = ASSET_TYPES[match[2].slice(match[2].lastIndexOf("."))];
  try {
    const body = readFileSync(join(...base));
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
}

function serveLocalHtml(res, filename, { strict = false } = {}) {
  let html = null;
  try { html = readFileSync(join(MODULE_DIR, "public", filename), "utf8"); } catch {}
  if (!html) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Could not find public/${filename}`);
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": strict ? STRICT_CSP
      : "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(html
    .replaceAll("__APP_RELEASE__", APP_RELEASE)
    .replaceAll("__RELAY_PROTOCOL_VERSION__", String(RELAY_PROTOCOL_VERSION)));
}

// 릴레이 결과에는 대화 본문 전체가 실린다. 일반 요청의 한도로는 실제 대화가 거부되고, 그러면
// 결과가 브로커에 도달하지 못해 스캔이 "relay timed out"으로 실패한다(2026-09-12 실측).
const MAX_RELAY_RESULT_BYTES = 64 * 1024 * 1024;

export function bodyLimitForPath(pathname) {
  return pathname === "/relay/result" ? MAX_RELAY_RESULT_BYTES : MAX_BODY_BYTES;
}

const readJsonBody = (req) => readRequestJson(req, bodyLimitForPath(new URL(req.url || "/", "http://127.0.0.1").pathname));

const server = createServer(async (req, res) => {
  const expectedHost = `${HOST}:${PORT}`;
  const expectedOrigin = `http://${expectedHost}`;
  if (req.headers.host !== expectedHost || (req.method === "POST" && req.headers.origin !== expectedOrigin)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  // 유지관리 화면
  if (req.method === "GET" && (req.url === "/" || req.url === "")) {
    serveLocalHtml(res, "app.html", { strict: true });

  } else if (req.method === "GET" && req.url.startsWith("/assets/")) {
    serveAsset(res, req.url.split("?")[0]);

  // 로컬 런처가 쓰는 준비 상태 확인
  } else if (req.method === "GET" && req.url === "/health") {
    jsonResponse(res, 200, { ok: true, service: "chatgpt-conversation-maintenance",
      relayProtocolVersion: RELAY_PROTOCOL_VERSION, ...appStatus(MODULE_DIR) });

  // 앱 종료. 실행 중인 작업이 있으면 force 없이는 거절한다(작업이 도중에 끊기지 않게).
  } else if (req.method === "POST" && req.url === "/app/shutdown") {
    let force = false;
    try { force = (await readJsonBody(req))?.force === true; } catch {}
    const running = [...jobs.values()].filter((job) => !job.done).length;
    if (running && !force) {
      jsonResponse(res, 409, { error: { message: "진행 중인 작업이 있어 종료하지 않았습니다. 작업이 끝나거나 중단된 뒤 다시 종료하세요." } });
    } else {
      jsonResponse(res, 200, { stopping: true, pid: process.pid });
      setTimeout(() => process.exit(0), 200);
    }

  // 화면이 쓰는 최소 설정: 삭제 후보 처리 방식의 기본값
  } else if (req.method === "GET" && req.url === "/config") {
    jsonResponse(res, 200, { trash: { ...configuredTrash(appFolders().workspace), defaultName: DEFAULT_TRASH_PROJECT } });

  // 북마클릿 설치 안내 페이지
  } else if (req.method === "GET" && req.url === "/auth/bookmarklet") {
    serveLocalHtml(res, "bookmarklet.html");

  // 유지관리 화면과 chatgpt.com 실행기 사이의 로컬 대기열. 원시 URL과 세션은 받지 않는다.
  } else if (req.url.startsWith("/relay/")) {
    await handleRemoteRelayRequest(req, res, { readJson: readJsonBody, jsonResponse });

  // 로컬 유지관리 워크플로 API. Host와 Origin은 위에서 검증했다.
  } else if (req.url.startsWith("/maintenance/")) {
    await handleMaintenanceWebRequest(req, res);

  } else {
    res.writeHead(404);
    res.end();
  }
});

const LOCAL_URL = `http://${HOST}:${PORT}`;

server.on("error", async (failure) => {
  const code = failure?.code || "";
  if (code === "EADDRINUSE") {
    // 같은 포트에 이미 앱이 떠 있다. 하나만 켜 둘 수 있으므로 새로 켜지 않고, 떠 있는 앱이 무엇인지 알려 준다.
    let running = null;
    try { running = await (await fetch(`${LOCAL_URL}/health`, { signal: AbortSignal.timeout(1500) })).json(); } catch {}
    console.error(running?.service === "chatgpt-conversation-maintenance"
      ? `\n이미 대화 정리 앱이 실행 중입니다 (프로세스 ${running.pid}, ${running.startedAt} 시작). 새로 켜지 않습니다.\n`
        + `끄려면 그 앱을 켠 터미널 창에서 Ctrl+C 를 누르거나 이 창에서 \`npm run stop\` 을 실행한 뒤 다시 켜세요.\n`
      : `\n${LOCAL_URL} 를 다른 프로그램이 이미 쓰고 있어 앱을 켤 수 없습니다.\n`);
    process.exit(1);
  }
  console.error(`\n로컬 서버를 시작할 수 없습니다: ${code || failure?.message || "알 수 없는 오류"}\n`);
  process.exit(1);
});

// 플랫폼별 기본 브라우저 실행 명령. 실패해도 서버는 계속 돈다.
const BROWSER_OPENERS = {
  darwin: "open",
  win32: "start",
  default: "xdg-open",
};

function revealInBrowser(target) {
  const platform = process.platform;
  const opener = BROWSER_OPENERS[platform] || BROWSER_OPENERS.default;
  const args = platform === "win32" ? ["/c", opener, "", target] : [target];
  const command = platform === "win32" ? "cmd.exe" : opener;
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

// 아직 한 번도 정리를 해 보지 않았는가(작업 로그가 없다).
function isFirstUse() {
  try { return readdirSync(join(appFolders().dataDir, "jobs")).length === 0; } catch { return true; }
}

export function startServer() {
  server.listen(PORT, HOST, () => {
    const line = "─".repeat(58);
    const first = isFirstUse();
    console.log(`\n${line}\n 대화 정리 앱이 실행 중입니다 (프로세스 ${process.pid})\n 주소: ${LOCAL_URL}\n`
      + ` 이 터미널 창이 앱입니다. 창을 닫거나 Ctrl+C 를 누르면 앱이 종료됩니다.\n\n`
      + ` 다음: chatgpt.com 에 로그인한 탭에서 북마클릿(ChatGPT → 유지관리)을 누르세요.\n`
      + ` 그러면 '대화 정리' 창이 열리고, 정리 작업은 그 창 하나에서 합니다.\n`
      + (first ? ` (처음이면 북마클릿 설치 안내를 브라우저에 열었습니다: ${LOCAL_URL}/auth/bookmarklet)\n` : "")
      + `${line}\n`);
    // 브라우저 창을 미리 열지 않는다(정리 창은 북마클릿이 연다). 처음 쓰는 사람에게만 북마클릿 설치 안내를 보여 준다.
    if (!NO_OPEN && first) revealInBrowser(`${LOCAL_URL}/auth/bookmarklet`);
  });

  // 터미널 창을 닫으면(SIGHUP) 앱도 함께 종료된다. 창이 이미 없어져 출력이 실패해도 종료를 막지 않는다.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => process.exit(0));
  }
}

// bin/cli.js가 import해서 명시적으로 시작한다. 직접 실행 시에만 자동 시작.
const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) startServer();
