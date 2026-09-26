// 알려진 프로젝트 목록(범위 선택용): 이름과 알고 있는 마지막 수정 시각. 스캔·프로젝트 목록 읽기가 끝날 때 갱신하는 읽기용 사본이며 판단의 근거가 아니다.
// 링크로 프로젝트를 찾을 수 있게 프로젝트 ID도 함께 둔다(이 파일은 데이터 폴더에만 있다). 순서는 최근에 쓴 프로젝트가 앞에 오도록 정렬해 준다.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeJsonAtomic } from "./fs-json.js";

const FILE = "known-projects.json";

const time = (value) => { const ms = Date.parse(value || ""); return Number.isFinite(ms) ? ms : null; };

// 수정 시각이 있는 프로젝트는 최근 순으로 앞에, 없는 프로젝트는 받은 순서(ChatGPT 목록 순서)대로 뒤에 둔다.
export function sortByRecency(projects) {
  const indexed = projects.map((project, index) => ({ project, index }));
  indexed.sort((a, b) => {
    const at = time(a.project.updatedAt); const bt = time(b.project.updatedAt);
    if (at !== null && bt !== null) return bt - at || a.index - b.index;
    if (at !== null) return -1;
    if (bt !== null) return 1;
    return a.index - b.index;
  });
  return indexed.map((item) => item.project);
}

export function readKnownProjects(dataDir) {
  try {
    const data = JSON.parse(readFileSync(join(dataDir, FILE), "utf8"));
    if (data?.version === 2 && Array.isArray(data.projects)) {
      return { updatedAt: data.updatedAt || null, projects: data.projects.filter((p) => typeof p?.name === "string") };
    }
  } catch {}
  return { updatedAt: null, projects: [] };
}

// projects: [{name, updatedAt?}]. 이미 아는 수정 시각은 더 최근 값으로 합친다.
export function writeKnownProjects(dataDir, projects, now = () => new Date()) {
  const previous = new Map(readKnownProjects(dataDir).projects.map((p) => [p.name, p]));
  const merged = projects.map((project) => {
    const known = previous.get(project.name);
    const candidates = [project.updatedAt, known?.updatedAt].filter(Boolean);
    const latest = candidates.sort((a, b) => (time(b) ?? 0) - (time(a) ?? 0))[0];
    // id 는 프로젝트 링크로 프로젝트를 찾는 데만 쓴다(데이터 폴더의 이 파일에만 있고 Git에 올라가지 않는다).
    const id = project.id ?? known?.id;
    return { name: project.name, ...(id ? { id } : {}), ...(latest ? { updatedAt: latest } : {}) };
  });
  const value = { version: 2, updatedAt: now().toISOString(), projects: sortByRecency(merged) };
  writeJsonAtomic(join(dataDir, FILE), value);
  return value;
}
