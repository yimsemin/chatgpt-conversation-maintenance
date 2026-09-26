// ChatGPT 프로젝트 주소(링크)에서 프로젝트 ID를 꺼낸다. 화면(브라우저)과 시험이 같은 규칙을 쓰는 순수 함수다.
// 프로젝트 ID는 `g-p-` + 32자리 16진수다(API_COMPATIBILITY.md). 주소 뒤에 붙는 경로(/project 등)나 이름은 무시한다.
export function projectIdFromLink(text) {
  const match = String(text || "").match(/\bg-p-[0-9a-f]{32}\b/i);
  return match ? match[0].toLowerCase() : null;
}
