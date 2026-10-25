// 지금 돌고 있는 앱 프로세스가 무엇인지 사용자가 알 수 있게 하는 정보: 프로세스 번호, 시작 시각, 시작 뒤 코드 변경 여부.
// 서버(/health)와 화면(세션)이 같은 값을 쓴다. 파일을 읽기만 한다.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { APP_VERSION } from "./app-version.js";

// 이 모듈을 처음 불러온 시각 = 앱 프로세스가 시작된 시각.
const STARTED_AT = Date.now();

// 시작한 뒤 바뀐 코드(루트 *.js, public/ 아래 파일)가 있는지. 있으면 화면이 "다시 켜세요"라고 알린다.
function latestSourceChange(rootDir) {
  let latest = 0;
  const visit = (dir, filter) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (!["node_modules", ".git", "data", ".local", "test", "docs"].includes(entry.name)) visit(path, () => true); continue; }
      if (!filter(entry.name)) continue;
      try { latest = Math.max(latest, statSync(path).mtimeMs); } catch {}
    }
  };
  visit(rootDir, (name) => name.endsWith(".js") || name === "package.json");
  visit(join(rootDir, "public"), () => true);
  return latest;
}

export function appStatus(rootDir, { now = Date.now() } = {}) {
  return {
    pid: process.pid,
    startedAt: new Date(STARTED_AT).toISOString(),
    uptimeSeconds: Math.max(0, Math.floor((now - STARTED_AT) / 1000)),
    version: APP_VERSION,
    codeChanged: latestSourceChange(rootDir) > STARTED_AT,
  };
}
