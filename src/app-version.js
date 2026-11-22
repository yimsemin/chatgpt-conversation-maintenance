import { readFileSync } from "node:fs";

const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// 제품 버전. package.json 이 유일한 원본이며 화면과 업데이트 내역에 보인다.
export const APP_VERSION = PACKAGE.version;

// GitHub 저장소 주소(화면의 링크와 릴리스 노트의 비교 링크가 쓴다).
export const REPO_URL = PACKAGE.repository.url.replace(/\.git$/, "");

// 앱 ↔ 북마클릿 연결 호환 버전(relay-MAJOR.MINOR.PATCH). 제품 버전과 따로 관리한다.
// 실행기나 릴레이 계약(src/remote-ops.js)이 바뀌면 MAJOR.MINOR 를 올리고, 겉모습만 바뀌면 PATCH 만 올린다(docs/GIT.md).
export const RELAY_VERSION = "relay-1.1.0";
