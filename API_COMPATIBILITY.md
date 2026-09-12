# ChatGPT 비공식 API 호환성 기록

마지막 검토일: 2026-09-11

이 저장소는 로그인한 사용자의 ChatGPT 데이터를 `https://chatgpt.com/backend-api`로 다룬다. 이는 ChatGPT 웹 앱의 비공개 계약이며 문서화되거나 지원되는 OpenAI API가 아니다. 공식 OpenAI Platform의 [Projects API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/projects)는 `organization.project`를 관리하며, 대화·파일·지침을 묶는 [ChatGPT 프로젝트](https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt)를 생성하거나 정리하는 API가 아니다.

이 문서는 비공식 API 표면의 단일 호환성 기록이다. 엔드포인트나 페이로드가 바뀌면 `remote-ops.js`, 페이지 실행기(`public/bookmarklet.html`), 릴레이 어댑터 테스트와 이 문서의 마지막 검토일을 함께 고친다. 사용 방법은 `README.md`, 에이전트 안전 경계는 `AGENTS.md`에 둔다.

## 인증 경계

지원하는 원격 경로는 북마클릿이 설치한 chatgpt.com 페이지 실행기 하나다. 실행기는 페이지 안에서 `/api/auth/session`을 읽어 `/backend-api` 요청 헤더를 구성하고, 로컬 앱 창과 `postMessage`로 연결된다. 앱이 보낸 고정된 `{op, params}`를 페이지 자체의 op→URL 표로 변환해 한 번에 하나씩 수행한다. 앱은 원시 URL을 보낼 수 없고 페이지는 표 밖의 URL을 만들지 않는다.

세션 응답·액세스 토큰·쿠키는 페이지 밖으로 보내지 않는다. 계정 ID만 적용 영수증의 계정 경계를 확인하기 위해 정제해 반환한다. `--auth stdin`, 세션 붙여넣기와 Node 직접 원격 호출은 폐기됐다. 브라우저 프로필이나 쿠키 데이터베이스도 읽지 않는다.

2026-08-11 실험에서 Codex 내장 브라우저는 ChatGPT 로그인과 프로젝트 UI 표시는 가능했지만, 페이지 평가 영역의 네트워크 호출과 `/backend-api` 직접 URL이 차단됐고 CLI로 세션을 전달하는 지원 인터페이스도 없었다. 따라서 내장 브라우저는 인증 경로로 사용하지 않는다. 이 제한을 인증정보 추출이나 UI 대량 조작으로 우회하지 않는다.

어느 인증 경로도 비공식 웹 엔드포인트를 공식 API나 무인 서비스 계정용 API로 바꾸지는 않는다.

## 현재 확인된 계약

| 기능 | `/backend-api` 아래 메서드와 경로 | 이 저장소가 사용하는 값 | 현재 근거 |
| --- | --- | --- | --- |
| 활성·보관 대화 목록 | `GET /conversations?offset={n}&limit=100&is_archived={boolean}` | 대화 요약, 전체 개수, 페이지 상태 | 2026-08-10 미지정 대화 카탈로그 과정에서 실계정 읽기 확인 |
| 대화 한 건 읽기 | `GET /conversation/{conversationId}` | `conversation_id`/`id`, 정확한 `title`, `gizmo_id`, 표시·보관 상태 | 변경 전후 검증에 사용 |
| 대화 수정 | `PATCH /conversation/{conversationId}` | 제목, `is_archived` 또는 `is_visible` | 승인된 정리 계획에서 사용 |
| 소유 프로젝트 목록 | `GET /gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0&limit=20` | `g-p-`로 시작하는 ID, 이름, 페이지 커서 | 2026-08-10 실계정 읽기 확인 |
| 프로젝트 대화 목록 | `GET /gizmos/{projectId}/conversations` | 대화 요약과 페이지 커서 | 2026-08-10 실계정 읽기 확인 |
| ChatGPT 프로젝트 생성 | `POST /projects` | `{ "name": string, "instructions": string }` | 2026-08-10 실계정 쓰기 확인 |
| 프로젝트에 대화 배치 | `PATCH /conversation/{conversationId}` | `{ "gizmo_id": "g-p-..." }` | 2026-08-10 검토된 57건 배치로 실계정 쓰기 확인 |

프로젝트 생성·배치는 제목 변경·삭제와 별도의 변경 계획을 사용하지만 하나의 사용자 승인 파일에서 두 계획을 컴파일할 수 있다. `project-cli.js`는 인벤토리 해시에 묶인 명시적 계획만 받고, 예상 원본 프로젝트가 `null`인 대화만 이동한다.

`g-`로 시작하는 `gizmo_id`는 대화를 만든 사용자 정의 GPT를 가리킬 수 있으므로 프로젝트 소속으로 취급하지 않는다. ChatGPT 프로젝트는 `g-p-`만 인정한다. 실계정 검증에서는 사용자 정의 GPT 대화를 프로젝트에 배치한 뒤 기존 `gizmo_id`와 `conversation_template_id`가 새 프로젝트 ID로 대체됐다. 호출자는 기존 사용자 정의 GPT 연결의 손실·대체 가능성을 예상해야 하며, 클라이언트는 원본 식별자를 기록하고 새 `g-p-` 값을 다시 읽어 검증한다. 브라우저 조작으로 자동 우회하지 않는다.

비공식 API는 상태를 실제로 바꾼 뒤 HTTP 500을 반환할 수 있다. 따라서 변경 응답 자체를 진실의 원천으로 삼지 않고, `POST /projects`와 프로젝트 배치 `PATCH`를 자동 재시도하지 않는다. 프로젝트 목록이나 대화를 다시 읽어 승인 계획과 원격 상태가 일치할 때만 성공으로 기록한다.

## 실측으로 확인된 제약

**Node 프로세스의 호출은 차단된다 (2026-09-09 관측).** 같은 계정·네트워크·세션 토큰으로 호출 주체만 바꿔 대조했다.

| 호출 주체 | 결과 |
| --- | --- |
| Node (`fetch`/undici) | `403` `text/html` (오류 안내 페이지) |
| chatgpt.com 페이지 안 (같은 출처 `fetch`) | `200` `application/json` |

원인은 TLS Client Hello 핑거프린트(JA3/JA4)가 비브라우저로 분류되는 것이다. 헤더를 어떻게 맞춰도 핸드셰이크 단계에서 걸러진다. 같은 증상이 OpenAI 자신의 `codex` CLI에도 미해결로 보고돼 있다([#17860](https://github.com/openai/codex/issues/17860), [#18688](https://github.com/openai/codex/issues/18688), [openclaw#62087](https://github.com/openclaw/openclaw/issues/62087)).

**하지 않는 대응**: TLS 핑거프린트 위조 프록시(`cloudscraper` 류), 브라우저 프로필·쿠키 직접 읽기, UI 대량 자동 조작.

**페이지 안에서는 읽기·쓰기가 모두 동작한다 (2026-09-11·09-12 실측).**

| 계약 | 결과 |
| --- | --- |
| `GET /conversation/{id}` | `200`, `mapping` 존재. 기존 파서가 유효하다 |
| `PATCH /conversation/{id}` `{title}` | `200` + `{success: true}`, 반영·원복 확인. 72건 적용 확인 |
| `PATCH /conversation/{id}` `{gizmo_id: "g-p-…"}` | `200`, 반영 확인. `conversation_template_id`가 대체됨. 38건 적용 확인 |
| `POST /projects` | `200`, 2건 생성 확인 |
| `PATCH /conversation/{id}` `{gizmo_id: null}` | **`200`이지만 반영되지 않는다** |
| 사이드바가 주는 프로젝트 ID | `g-p-` + 32 hex, slug 없음 |

두 가지가 계속 구현을 제약한다.

- **프로젝트에서 빼는 계약이 없다.** `gizmo_id: null`은 동작하지 않는다. 따라서 프로젝트 간 이동과 제거를 지원하지 않는다. 대화가 이미 프로젝트에 있으면 사용자가 ChatGPT에서 직접 옮긴 뒤 다시 스캔한다.
- **변경 응답 `200`이 반영을 뜻하지 않는다.** 변경 후 재조회 검증을 생략할 수 없다.

**`create_time`은 수집 경로에 따라 다르다 (2026-09-12 관측).** 같은 대화의 `create_time`이 주 목록 경유와 프로젝트 목록 경유에서 47초 차이로 보고됐다. 생성 시각은 불변이므로 실제 변경이 아니다. 따라서 **`create_time`을 변경 감지 신호로 쓰지 않는다** — 동일성은 `conversationId`로 확정하고, 변경 감지는 `title`·`update_time`·`is_archived`·`gizmo_id`로 한다.

**페이징 주의.** 주 대화 목록은 **수정시각 순**이고 `offset`으로 페이지를 넘긴다. 대량 쓰기 직후 재조회하면 항목이 페이지 사이로 이동해 주 목록에서 밀릴 수 있다. 프로젝트별 목록 병합이 누락을 메우지만, 대량 변경 직후의 재조회 결과를 그 자체로 완전하다고 가정하지 않는다.

**rate limit.** 대량 쓰기에서 `429`가 지속적으로 발생한다. 제목 72건에 약 77분, 프로젝트 배치 38건에 약 78분이 걸렸다(2026-09-12). 쿨다운·백오프가 흡수하고 영수증으로 이어서 재시도된다. 대량 변경은 오래 걸린다고 예상해야 한다.

## 계약이 깨졌을 때의 순서

1. 실패한 계획과 토큰이 없는 영수증을 보존한다. 프로젝트 목록에서 동일한 결과가 없음을 확인하기 전에는 생성 요청을 반복하지 않는다.
2. 읽기 전용 프로젝트 목록과 대화 읽기를 다시 실행해 인증, 계정 헤더, 페이지 처리와 쓰기 계약 문제를 분리한다.
3. 근거가 부족하면 ChatGPT 웹 앱의 네트워크 계약을 소량·읽기 중심으로 관찰한다. 메서드, 경로, 최소 페이로드, 모호한 응답과 날짜만 기록하고 세션 토큰은 기록하지 않는다.
4. 가장 작은 어댑터 범위만 바꾸고 이 표와 회귀 테스트를 함께 갱신한다. 실제 적용 전에 전체 테스트를 실행한다.
5. 새 프로젝트 하나·대화 하나의 새 계획으로 첫 실계정 검증을 수행한다. 재조회 상태와 영수증을 확인한 뒤에만 배치 크기를 늘린다.

공식 OpenAI Platform Projects API의 변화만으로 ChatGPT Projects 웹 API의 변화를 추정하지 않는다. 두 기능의 제품과 리소스 종류가 다르다.
