// 실제 ChatGPT 대화 ID 는 RFC 4122 의 버전 1~5 가 아니다. 예: 6aa3d0e3-2eac-83e9-...
// 의 버전 니블은 8 이다. 버전·variant 를 제한하면 실제 ID 가 전부 거부된다(2026-09-12 실측).
// 경로 주입을 막는 데는 8-4-4-4-12 16진수 형태만으로 충분하다. 실측 없이 조이지 않는다.
export const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ACCOUNT_ID = CONVERSATION_ID;
export const PROJECT_ID = /^g-p-[0-9a-f]{32}$/;
