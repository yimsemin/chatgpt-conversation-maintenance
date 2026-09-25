// 카탈로그 항목 두 개가 어떤 필드에서 달라졌는지 비교한다(드리프트 진단·검증에서 쓴다).
import { sameTime } from "./catalog.js";

// 어떤 필드가 달라졌는지 이름으로 돌려준다. 드리프트 오류가 대화 ID만 알려주면
// 원격에서 무엇이 바뀐 것인지 알 수 없어 복구 판단을 할 수 없다.
// createTime 은 비교하지 않는다. 생성 시각은 불변이라 변경 신호를 담지 않고, 실측에서
// 같은 대화의 create_time 이 수집 경로에 따라 다르게 보고됐다(2026-09-12, 47초 차이).
// 대화의 동일성은 conversationId 로 이미 확정된다. 상세는 API_COMPATIBILITY.md.
export function catalogItemDifferences(before, current) {
  const fields = [];
  if (before.title !== current.title) fields.push("title");
  if (!sameTime(before.updateTime, current.updateTime)) fields.push("updateTime");
  if (before.isArchived !== current.isArchived) fields.push("isArchived");
  if ((before.projectName || null) !== (current.projectName || null)) fields.push("projectName");
  return fields;
}

// 드리프트 사유를 사람이 읽을 수 있게 만든다. 제목·프로젝트명은 사용자 데이터이므로
// 값 자체는 남기지 않고 "무엇이 바뀌었는지"와 보관 여부만 남긴다.
export function describeMetadataDrift(before, current) {
  const fields = catalogItemDifferences(before, current)
    .filter((field) => field !== "title" && field !== "updateTime");
  return fields.map((field) => {
    // 시각은 대화 내용이 아니라 메타데이터이므로 값을 남긴다. 값이 없으면 원인을 못 찾는다.
    if (field === "createTime" || field === "updateTime") {
      return `${field} ${JSON.stringify(before[field])} -> ${JSON.stringify(current[field])}`;
    }
    if (field === "isArchived") return `isArchived ${before.isArchived} -> ${current.isArchived}`;
    if (field === "projectName") {
      const from = before.projectName ? "프로젝트 있음" : "프로젝트 없음";
      const to = current.projectName ? "프로젝트 있음" : "프로젝트 없음";
      return from === to ? "projectName 변경(다른 프로젝트로 이동)" : `projectName ${from} -> ${to}`;
    }
    return field;
  }).join(", ");
}

export function catalogItemEqual(left, right) {
  return left.conversationId === right.conversationId
    && left.title === right.title
    && sameTime(left.updateTime, right.updateTime)
    && left.isArchived === right.isArchived
    && (left.projectName || null) === (right.projectName || null);
}
