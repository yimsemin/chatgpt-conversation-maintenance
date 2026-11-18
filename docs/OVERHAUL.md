# ChatGPT 계정의 프로젝트와 대화 재정비

ChatGPT 계정의 대화 전체를 살펴보고, 앞으로 함께 참고할 대화끼리 프로젝트를 다시 구성한다. 새 프로젝트 체계를 정한 뒤 대화별 배치·제목·삭제후보를 제안한다.

## 역할

사용자는 화면에서 수집·검토·적용하고 프로젝트 체계를 결정한다. 에이전트는 카드·체계 초안·분류 제안을 만들고 검증한다.

[분류 기준](CLASSIFICATION_WORKFLOW.md)을 적용한다. 기존 프로젝트명과 분류체계는 새 구조를 설계할 때 참고한다. 판단이 어려운 대화는 카드에 근거를 적고 판정에서 `undecided`로 둔다.

## 단계

1. **수집** — 사용자가 **모든 대화**를 수집한다. 중단했다면 같은 범위로 이어받고, 전체 구조를 설계하기 전에 수집 누락을 확인한다. [수집 범위와 옵션](ARCHITECTURE.md#수집-범위와-옵션)
2. **카드화** — 인벤토리에서 만든 `review.json`을 크기 기준으로 조각내 병렬 에이전트에 나눠, 대화당 짧은 카드로 압축한다. 카드는 `runs/<id>/cards/`에 둔다. 조각을 나누는 기준은 프로젝트가 아니라 **무작위·균등**으로 한다(기존 분류에 끌려가지 않기 위해).
3. **체계 설계** — 전체 카드를 **한 컨텍스트**에서 읽고 프로젝트 체계를 설계한다. 결과는 프로젝트별 정의(범위·포함 기준·예상 대화 수·기존 프로젝트 대응)이며, **사용자 승인**을 받는다.
4. **판정** — 승인된 체계로 대화별 배치·제목·삭제를 정한다. 조각별 병렬 처리하되 체계와 기준은 동일하게 준다. 결과는 기존 `proposal.json` 스키마로 만들어 기존 검증기를 통과시킨다.
5. **검토** — 프로젝트별 변화, 새 프로젝트, 삭제후보와 확신이 낮은 항목을 우선 확인한다. 보존할 대화 중 `manual-remove`는 결과에서 직접 처리할 대상으로 안내한다.
6. **적용** — 사용자가 화면에서 적용을 시작한다. 중단 후에는 같은 실행의 완료 기록을 확인해 이어간다. 요청 제한으로 기다릴 때는 화면의 재개 안내를 따른다. [수집·적용 재개](ARCHITECTURE.md#수집적용-재개)
7. **마무리** — 결과의 **직접 하실 일**을 확인하고, 새 프로젝트 경계를 계속 쓸 경우 분류체계에 반영한다. [분류체계 예시](../templates/classification-taxonomy.example.md)

### 카드 형식 (대화당 한 객체, 짧게)

```json
{
  "id": "대화 UUID",
  "topic": "주제 12자 이내",
  "refs": ["관련 repo·문서 이름"],
  "state": "active | done | superseded | oneoff | test",
  "value": "high | mid | low | none",
  "harm": "none | stale | conflicts-with-source",
  "why": "보존/삭제 근거 한 줄",
  "title": "표준 형식의 제목 초안 또는 null"
}
```

## 카드 도구 사용

```bash
node src/overhaul.js slice <inventory.json> <runs/id/slices> --parts N [--seed S]   # 무작위·균등 조각
node src/overhaul.js validate-cards <inventory.json> <runs/id/cards>               # 카드 형식·커버리지
node src/overhaul.js assemble <inventory.json> <runs/id/verdicts> <proposal.json>  # 판정 → proposal.json + 기존 검증
```

카드 파일은 조각마다 카드 배열(JSON), 판정 파일은 `{id, decision, title|null, project|null, confidence, why, projectWhy?}` 배열이다.

## 마무리 전 확인

- 프로젝트를 삭제하면 안의 대화도 사라질 수 있다. 사용자가 비어 있는 것을 확인한 뒤 직접 삭제한다.
