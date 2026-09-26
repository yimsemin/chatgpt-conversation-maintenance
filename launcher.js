#!/usr/bin/env node
// 앱 실행·종료·상태 확인. 앱은 이 터미널 창의 프로세스로 돈다(백그라운드에 숨지 않는다).
//   node launcher.js          앱을 켠다. 이 창이 앱이다 — 창을 닫거나 Ctrl+C 를 누르면 앱이 종료된다.
//   node launcher.js stop     실행 중인 앱을 끈다(그 터미널 창을 찾을 수 없을 때).
//   node launcher.js status   실행 중인 앱이 있는지, 있다면 어떤 프로세스인지 보여 준다.
// 앱은 하나만 켜 둘 수 있다. 이미 켜져 있으면 새로 켜지 않는다.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";

// 어디서 실행하든(더블클릭·다른 폴더의 터미널) 앱의 작업 폴더는 이 저장소 폴더다.
const ROOT = dirname(fileURLToPath(import.meta.url));
process.chdir(ROOT);

const URL = `http://127.0.0.1:${CONFIG.port}`;

function assertSupportedNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 24) {
    throw new Error(`Node.js 24 이상이 필요합니다. 현재 버전: ${process.version}`);
  }
}

// 이미 떠 있는 우리 앱의 정보. 없거나 다른 프로그램이면 null.
async function runningApp() {
  try {
    const response = await fetch(`${URL}/health`, { signal: AbortSignal.timeout(1500), cache: "no-store" });
    const body = await response.json();
    return response.ok && body?.service === "chatgpt-conversation-maintenance" ? body : null;
  } catch { return null; }
}

function describe(app) {
  return `프로세스 ${app.pid} · ${app.startedAt} 시작${app.codeChanged ? " · 시작한 뒤 코드가 바뀌었습니다(다시 켜야 새 코드가 적용됩니다)" : ""}`;
}

async function stop() {
  const app = await runningApp();
  if (!app) { console.log("실행 중인 대화 정리 앱이 없습니다."); return 0; }
  const response = await fetch(`${URL}/app/shutdown`, { method: "POST", headers: { "Content-Type": "application/json", Origin: URL },
    body: JSON.stringify({ force: process.argv.includes("--force") }), signal: AbortSignal.timeout(3000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { console.error(body?.error?.message || `종료하지 못했습니다 (HTTP ${response.status})`); console.error("그래도 끄려면 `npm run stop -- --force` 를 실행하세요."); return 1; }
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (!await runningApp()) { console.log(`앱을 종료했습니다 (프로세스 ${app.pid}).`); return 0; }
  }
  console.error("종료를 요청했지만 앱이 아직 응답합니다."); return 1;
}

async function status() {
  const app = await runningApp();
  console.log(app ? `실행 중: ${describe(app)}\n주소: ${URL}` : "실행 중인 대화 정리 앱이 없습니다.");
  return 0;
}

async function start() {
  const app = await runningApp();
  if (app) {
    console.error(`\n이미 대화 정리 앱이 실행 중입니다 (${describe(app)}).\n`
      + "새로 켜지 않습니다. 그 앱을 켠 터미널 창이 있으면 그 창에서 Ctrl+C 로 끄고, 창을 찾을 수 없으면 `npm run stop` 으로 끈 뒤 다시 켜세요.\n"
      + `이미 켜진 앱을 쓰려면 브라우저에서 ${URL} 을 여세요.\n`);
    return 1;
  }
  const { startServer } = await import("./server.js");
  startServer();
  return null; // 서버가 이 프로세스를 붙들고 있다
}

async function main() {
  assertSupportedNode();
  const command = process.argv.slice(2).find((arg) => !arg.startsWith("--")) || "start";
  const code = command === "stop" ? await stop() : command === "status" ? await status() : command === "start" ? await start()
    : (console.error("사용법: node launcher.js [start|stop|status]"), 1);
  if (code !== null) process.exit(code);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
