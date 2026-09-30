#!/usr/bin/env node
// 실행 폴더(data/runs/*/json/)에 쌓인 대화 본문 사본 중 중복을 정리한다. 같은 대화의 본문이 여러 실행에 있으면 수정 시각이 가장 새로운
// 것 하나만 남긴다(수집 재활용의 저장소이기도 하다). 기본은 미리보기이고 --apply 를 줘야 지운다. 결정·계획·영수증·보고서는 건드리지 않는다.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDataDir, runsDir } from "./data-dir.js";
import { timeMilliseconds } from "./catalog.js";
import { acquireLock, releaseLock } from "./maintenance-lock.js";
import { readTrash } from "./trash.js";

function readJsonOrNull(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

// 지우지 않는 본문: 진행 중인 실행(가리키는 실행 폴더) 전체, 인벤토리가 아직 없는(이어받을 수 있는) 실행 전체, 삭제후보 목록이 가리키는 파일.
export function planPrune({ dataDir, currentRunDir = null }) {
  const root = runsDir(dataDir);
  const current = currentRunDir ? resolve(currentRunDir) : null;
  const protectedFiles = new Set(readTrash(dataDir).items.map((item) => item.backupFile).filter(Boolean).map((file) => resolve(file)));
  const copies = new Map(); // conversationId -> [{ file, run, bytes, protectedCopy, at }]
  const dirs = existsSync(root) ? readdirSync(root).map((name) => join(root, name)).filter((dir) => statSync(dir).isDirectory()) : [];
  for (const dir of dirs) {
    const jsonDir = join(dir, "json");
    if (!existsSync(jsonDir)) continue;
    const wholeRun = dir === current || !existsSync(join(dir, "inventory.json"));
    const at = statSync(dir).mtimeMs;
    for (const name of readdirSync(jsonDir).filter((item) => item.endsWith(".json"))) {
      const file = join(jsonDir, name);
      const list = copies.get(name.slice(0, -5)) || [];
      list.push({ file, run: basename(dir), bytes: statSync(file).size, protectedCopy: wholeRun || protectedFiles.has(resolve(file)), at });
      copies.set(name.slice(0, -5), list);
    }
  }
  const remove = []; let totalBytes = 0; let keptBytes = 0;
  for (const [id, list] of copies) {
    totalBytes += list.reduce((sum, copy) => sum + copy.bytes, 0);
    if (list.length === 1) { keptBytes += list[0].bytes; continue; }
    for (const copy of list) copy.time = timeMilliseconds(readJsonOrNull(copy.file)?.update_time);
    // 수정 시각을 읽을 수 없는 사본이 있으면 그 대화는 손대지 않는다. 그 밖에는 보호된 사본 전부와 수정 시각이 가장 새로운 사본 하나를 남긴다.
    if (list.some((copy) => copy.time === null)) { keptBytes += list.reduce((sum, copy) => sum + copy.bytes, 0); continue; }
    const best = [...list].sort((a, b) => b.time - a.time || Number(b.protectedCopy) - Number(a.protectedCopy) || b.at - a.at)[0];
    for (const copy of list) {
      if (copy.protectedCopy || copy === best) keptBytes += copy.bytes;
      else remove.push({ id, file: copy.file, run: copy.run, bytes: copy.bytes });
    }
  }
  return { remove, freedBytes: remove.reduce((sum, item) => sum + item.bytes, 0), totalBytes, keptBytes, conversations: copies.size };
}

export function applyPrune(plan) {
  const emptied = new Set();
  for (const item of plan.remove) { rmSync(item.file, { force: true }); emptied.add(resolve(item.file, "..")); }
  for (const dir of emptied) if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  return plan.remove.length;
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)}MB`;

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const appRoot = fileURLToPath(new URL("..", import.meta.url));
  const dataDir = resolveDataDir({ appRoot });
  const pointer = readJsonOrNull(join(appRoot, ".local", "maintenance-web.json"));
  const plan = planPrune({ dataDir, currentRunDir: pointer?.runDir || null });
  const perRun = new Map();
  for (const item of plan.remove) perRun.set(item.run, (perRun.get(item.run) || 0) + item.bytes);
  console.log(`본문 사본 ${plan.conversations}개 대화 · 전체 ${mb(plan.totalBytes)} · 중복 ${plan.remove.length}개 ${mb(plan.freedBytes)}를 지울 수 있습니다.`);
  for (const [run, bytes] of [...perRun].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${mb(bytes).padStart(9)}  ${run}`);
  if (!process.argv.includes("--apply")) console.log("미리보기입니다. 지우려면 앱을 끈 상태에서 --apply 를 붙여 실행하세요.");
  else {
    acquireLock({ dataDir });
    try { console.log(`${applyPrune(plan)}개를 지웠습니다.`); } finally { releaseLock({ dataDir }); }
  }
}
