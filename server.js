#!/usr/bin/env node
/**
 * 로컬 대화 유지관리 웹앱 서버.
 *
 * `127.0.0.1:8523`에서만 동작하며 외부에 배포되지 않는다. 화면(`public/maintenance.html`)을
 * 서빙하고, 유지관리 워크플로 API(`/maintenance/*`, maintenance-web.js)를 위임한다.
 * 비공개 ChatGPT API 호출은 이 파일에 없다. chatgpt.com 페이지의 릴레이 실행기가 수행한다.
 */

import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { handleMaintenanceWebRequest } from "./maintenance-web.js";
import { resolveDataDir } from "./data-dir.js";
import { handleRemoteRelayRequest } from "./remote-relay.js";
import { APP_RELEASE, RELAY_PROTOCOL_VERSION } from "./app-version.js";

// 새로 만드는 파일·디렉터리를 현재 OS 사용자로 제한한다(플랫폼이 umask를 지원하는 경우).
try { process.umask(0o077); } catch {}

// 이 모듈이 놓인 디렉터리. import.meta.url 을 쓸 수 없는 실행 형태에서는 실행 경로로 되돌린다.
function resolveModuleDir() {
  if (import.meta.url) {
    try { return dirname(fileURLToPath(import.meta.url)); } catch {}
  }
  return dirname(process.argv[1] || ".");
}

const MODULE_DIR = resolveModuleDir();

const NO_OPEN = process.argv.includes("--no-open");

const HOST = "127.0.0.1";
const PORT = 8523;

function serveLocalHtml(res, filename) {
  const candidates = [
    join(MODULE_DIR, "public", filename),
    join(dirname(process.execPath), "public", filename),
    join(process.cwd(), "public", filename),
  ];
  let html = null;
  for (const path of candidates) {
    try { html = readFileSync(path, "utf8"); break; } catch {}
  }
  if (!html) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Could not find public/${filename}`);
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(html
    .replaceAll("__APP_RELEASE__", APP_RELEASE)
    .replaceAll("__RELAY_PROTOCOL_VERSION__", String(RELAY_PROTOCOL_VERSION)));
}

function jsonResponse(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;
// 릴레이 결과에는 대화 본문 전체가 실린다. 2MB 한도로는 실제 대화가 거부되고, 그러면
// 결과가 브로커에 도달하지 못해 스캔이 "relay timed out"으로 실패한다(2026-09-12 실측).
const MAX_RELAY_RESULT_BYTES = 64 * 1024 * 1024;

export function bodyLimitForPath(pathname) {
  return pathname === "/relay/result" ? MAX_RELAY_RESULT_BYTES : MAX_BODY_BYTES;
}

async function readRequestJson(req) {
  const limit = bodyLimitForPath(new URL(req.url || "/", "http://127.0.0.1").pathname);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

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
    serveLocalHtml(res, "maintenance.html");

  // 로컬 런처가 쓰는 준비 상태 확인
  } else if (req.method === "GET" && req.url === "/health") {
    jsonResponse(res, 200, { ok: true, service: "chatgpt-conversation-maintenance",
      release: APP_RELEASE, relayProtocolVersion: RELAY_PROTOCOL_VERSION });

  // 화면이 쓰는 최소 설정 (기본 작업 폴더, 데이터 폴더 위치)
  } else if (req.method === "GET" && req.url === "/config") {
    let dataDir = null;
    try { dataDir = resolveDataDir({ appRoot: MODULE_DIR }); } catch {}
    jsonResponse(res, 200, { platform: process.platform, workspace: process.cwd(), dataDir,
      release: APP_RELEASE, relayProtocolVersion: RELAY_PROTOCOL_VERSION });

  // 북마클릿 설치 안내 페이지
  } else if (req.method === "GET" && req.url === "/auth/bookmarklet") {
    serveLocalHtml(res, "bookmarklet.html");

  // 유지관리 화면과 chatgpt.com 실행기 사이의 로컬 대기열. 원시 URL과 세션은 받지 않는다.
  } else if (req.url.startsWith("/relay/")) {
    await handleRemoteRelayRequest(req, res, { readJson: readRequestJson, jsonResponse });

  // 로컬 유지관리 워크플로 API. Host와 Origin은 위에서 검증했다.
  } else if (req.url.startsWith("/maintenance/")) {
    await handleMaintenanceWebRequest(req, res);

  } else {
    res.writeHead(404);
    res.end();
  }
});

const LOCAL_URL = `http://${HOST}:${PORT}`;

server.on("error", (failure) => {
  const code = failure?.code || "";
  if (code === "EADDRINUSE") {
    // 이미 떠 있는 앱이 있다는 뜻이므로 실패로 취급하지 않는다.
    console.error(`\n이미 ${LOCAL_URL} 에서 앱이 실행 중입니다. 브라우저에서 그 주소를 여세요.\n`);
    process.exit(0);
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

export function startServer() {
  server.listen(PORT, HOST, () => {
    console.log(`\n대화 유지관리 앱: ${LOCAL_URL}`);
    console.log("종료하려면 Ctrl+C 를 누르세요.\n");
    if (!NO_OPEN) revealInBrowser(LOCAL_URL);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => process.exit(0));
  }
}

// bin/cli.js가 import해서 명시적으로 시작한다. 직접 실행 시에만 자동 시작.
const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) startServer();
