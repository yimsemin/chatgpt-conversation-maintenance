// 표준 제목 형식 "주제 — 작업/결과". 규칙의 정본은 CLASSIFICATION_WORKFLOW.md다.
export function isNormalizedTitle(title) {
  if (typeof title !== "string" || title !== title.trim()) return false;
  const parts = title.split(" — ");
  return parts.length === 2
    && parts.every((part) => part.length > 0 && part === part.trim() && !part.includes("—"));
}
