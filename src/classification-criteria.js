// 분류 판단 기준의 압축본과 제안 파일 형식. review.json·요청문에 그대로 들어간다(정본은 CLASSIFICATION_WORKFLOW.md).


// 규칙 문서를 매번 통째로 보내지 않기 위한 압축 기준. 정본은
// CLASSIFICATION_WORKFLOW.md이며 이 배열은 그 요약이다. review.json과 Claude
// 요청문에 그대로 삽입된다.
export const CLASSIFICATION_CRITERIA = [
  "목적: 필요한 과거 맥락은 살리고, 오래되거나 잘못된 맥락이 답변에 섞이는 것을 줄이며, 관리 부담을 줄인다. 판단이 갈리면 '앞으로 ChatGPT를 더 정확하고 적은 관리비용으로 쓸 수 있는가'로 정한다.",
  "역할: 각 후보에 delete·keep·undecided 중 하나, confidence(high|medium|low), 한 문장 근거를 제안한다. 승인·실행·실제 변경은 하지 않는다.",
  "delete: 재사용 가치가 없으면 삭제한다 — 테스트·실수·잡음, 중복, 실패·중단만 남은 것, 완료된 일회성, 일상·가십·잡담처럼 업무·프로젝트와 무관하고 맥락 없는 일회성 질문(다른 대화에 예시로 끌려 들어가 답변을 오염시킬 수 있다), 결과가 원본(repo·문서)에 이미 반영되어 대화에 고유한 것이 없는 것, 현재 원본과 충돌해 남으면 해로운 것. 재사용 가치란 향후 같은 프로젝트 대화가 참조할 결정·근거·조사결과·산출물·선호가 있고 원본이나 후속 대화에 없는 경우다.",
  "keep: 원본에 없는 결정·근거·기각한 대안·조사결과·산출물·사용자 선호가 있다. 오래됐다는 이유만으로 삭제하지 않는다. 길이는 메시지 수가 아니라 사용자 요청과 고유 산출물로 판단한다.",
  "undecided: 대화만으로 판단하기 어려운 경우에만, 이유를 근거에 적는다. 남발하지 않는다.",
  "repo가 있는 프로젝트는 현재 repo가 진실이다. 과거 대화 내용을 현재 상태로 간주하지 않는다.",
  "제목(keep·undecided는 필수 제안, delete도 예외 없이 표준 제목이 원칙이므로(삭제후보 프로젝트로 옮겨 살릴 수 있다) 현재 제목이 표준 형식이 아니면 표준 제목을 반드시 제안): 형식은 `핵심 대상·주제 — 실제 작업 또는 결과`. 구분자는 정확히 한 번의 ` — `(양쪽 공백 1칸의 em dash), 양쪽은 비어있지 않음.",
  "현재 제목이 이 형식이고 대화 전체를 정확·구체적으로 나타내면 suggestedNewTitle을 null로 둔다. 형식이 아니면 내용이 맞아도 표준 형식의 새 제목을 제안한다.",
  "제목은 첫 질문이 아니라 대화의 최종 내용(주된 목적과 실제 결과)을 반영한다. 중복 제목은 고유 초점으로 구분한다. 날짜·버전은 시점이 핵심일 때만. 상태 태그·막연한 표현·대화에 없는 결론 금지. 대체로 15~35자.",
  "제목은 소속 프로젝트(최종 프로젝트)의 이름·핵심어를 반복하지 않는다(동어반복 금지). 프로젝트 안에서 이 대화를 다른 대화와 구별하는 대상·작업·결과만 쓴다. 예: 프로젝트가 「2610 말레이시아 출장 준비」이면 `말레이시아 출장 — …`이 아니라 `현지 교통편 — 이동 수단별 비용과 소요 비교`처럼 쓴다. 프로젝트 없음이면 대상을 스스로 알 수 있게 쓴다.",
  "프로젝트(keep·undecided만): '같은 프로젝트에 있으면서 서로를 과거 맥락으로 참조할 때 답변 품질에 도움이 되는가'로 정한다. 맞는 프로젝트가 없으면 프로젝트 없음이 정상이다(suggestedProjectName null). 모든 대화를 억지로 프로젝트에 넣지 않는다.",
  "기존 프로젝트 배치가 잘못됐을 수 있다. 현재 프로젝트를 옳다고 가정하지 않는다. 너무 큰 프로젝트도, 작은 차이로 잘게 쪼갠 프로젝트도 피한다.",
  "프로젝트 조치: 프로젝트가 없는 대화는 새·기존 프로젝트에 배치(use-or-create) 또는 프로젝트 없음(none). 현재 프로젝트가 적합하면 keep-current. 다른 프로젝트로 옮길 것이면 manual-move. 이미 프로젝트 안에 있는데 프로젝트 없음이 맞으면 manual-remove(API로 뺄 수 없어 사용자가 수동 처리).",
  "confidence: 명시적 근거는 high, 내용상 추론은 medium, 근거가 부족하면 low(그리고 undecided).",
  "delete 항목은 suggestedProjectName·projectRationale를 넣지 않고 suggestedProjectAction은 none. 현재 제목이 표준 형식이 아니면 표준 제목을 suggestedNewTitle에 반드시 넣는다(삭제후보도 표준 제목이 원칙이다). 표준이면 null.",
];

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
