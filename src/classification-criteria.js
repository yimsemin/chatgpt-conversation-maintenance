import { translator } from "./i18n.js";

// 분류 판단 기준의 압축본과 제안 파일 형식. review.json·요청문에 그대로 들어간다(정본은 docs/CLASSIFICATION_WORKFLOW.md).


// 규칙 문서를 매번 통째로 보내지 않기 위한 압축 기준. 정본은
// docs/CLASSIFICATION_WORKFLOW.md이며 이 배열은 그 요약이다. review.json과 Claude
// 요청문에 그대로 삽입된다.
const CRITERIA_KEYS = [
  "criteria.purpose",
  "criteria.role",
  "criteria.delete",
  "criteria.keep",
  "criteria.undecided",
  "criteria.repo",
  "criteria.titleFormat",
  "criteria.keepTitle",
  "criteria.titleContent",
  "criteria.titleProject",
  "criteria.project",
  "criteria.projectSize",
  "criteria.projectAction",
  "criteria.confidence",
  "criteria.deleteFields",
  "criteria.language",
];

export function classificationCriteria(locale) {
  const t = translator(locale);
  return CRITERIA_KEYS.map((key) => t(key));
}

export const CLASSIFICATION_CRITERIA = classificationCriteria();

export const CLASSIFICATION_PROPOSAL_SCHEMA = {
  version: 1,
  kind: "classification-proposals",
  inventoryDigest: "후보 inventory.json의 SHA-256",
  scope: { candidateCount: 0 },
  items: [
    {
      conversationId: "대화 UUID",
      currentTitle: "현재 제목",
      projectName: null,
      reasons: ["scope"],
      suggestedDecision: "keep",
      suggestedNewTitle: "핵심 주제 — 실제 작업 또는 결과",
      suggestedProjectAction: "keep-current | use-or-create | manual-move | manual-remove | none",
      suggestedProjectName: "최종 프로젝트명 또는 null(프로젝트 없음)",
      confidence: "high",
      rationale: "간결한 보존·삭제 판단 근거",
      projectRationale: "현재 또는 새 프로젝트가 적합한 이유",
    },
  ],
};
