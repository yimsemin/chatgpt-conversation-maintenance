# 구조와 그 이유

현재 구현된 구조다. 코드와 어긋나면 코드·테스트가 정본이고 이 문서를 고친다.

## 세 계층

### A. 로컬 앱 (판단)

`127.0.0.1:8523`에서만 동작하는 웹 화면. 외부에 배포되지 않는다. **AI를 호출하지 않는다** — 분류는 계층 C로 넘긴다.

**화면**(`public/app.html` + `public/assets/*`, 엄격한 CSP: 외부·인라인 스크립트 없음)은 정기 정리 흐름 하나를 중심으로 한다: 현황 → 확인 → 제안 → 검토 → 적용 → 결과. 검토는 요약(무엇이 바뀌는가, 프로젝트별 증감)과 예외 목록만 보이고, 검토 대기(임시 보관) 확정은 별도 화면이다. 전체 목록을 직접 편집하는 이전 화면은 `/legacy`에 남아 있다. 화면과 서버가 공유하는 순수 계산(`summary.js`, `title-rules.js`)은 `/assets/shared/`로 그대로 서빙한다.

**서버**는 라우트 표(`maintenance-web.js`)와 역할별 모듈로 나뉜다. 위 계층이 아래를 부르고 거꾸로는 부르지 않는다(`test/architecture.test.js`가 강제한다).

| 계층 | 모듈 | 책임 |
| --- | --- | --- |
| 라우터 | `maintenance-web.js` | `/maintenance/*` 라우트 표. 작업 폴더 검증·릴레이 확인·작업 시작 공통 처리 |
| 워크플로 | `web-workflows.js` | 스캔·기준선 만들기·확정·적용(`applyWorkflow`는 점검→컴파일→제목삭제→체크포인트→배치→마무리 단계 함수를 부르는 조정자) |
| 결정 | `web-decisions.js` | 결정 검증·저장, 임시 보관 정보, 후속 실행 준비 |
| 화면 데이터 | `web-views.js` | 세션·요약·보고서·분류안·카탈로그(읽기 전용) |
| 작업 | `web-jobs.js` | 작업 목록·이벤트·진행률, 자동 재개, 릴레이 API 생성 |
| 공용 | `web-common.js` | 작업 폴더 검증, 현재 실행 포인터, 안전한 오류 진단 |

| 영역 | 모듈 | 책임 |
| --- | --- | --- |
| 카탈로그 | `catalog.js` | 수집: 프로젝트를 순회하는 전체 수집(crawl) 하나 |
| 스캔·검증 | `scan.js`, `checkpoint.js`, `baseline.js`, `catalog-diff.js` | 후보 선정·본문 받기, 적용 뒤 검증(체크포인트·배치 동기화·빠른 검증), 기준선 만들기·확정, 항목 비교 |
| 분류 | `classification-criteria.js`, `classification-review.js`, `proposal-validation.js`, `decision-compile.js`, `workflow.js`(로컬 명령) | 판단 기준 압축본, `review.json`·요청문, 제안 검증, 결정 → 실행 계획 |
| 적용 엔진 | `management.js`, `plan-set.js`, `project-management.js`, `project-routing.js` | 제목·삭제 계획, 배치 묶음, 프로젝트 생성·배치·이동 |
| 순수 계산·상태 | `summary.js`, `session.js`, `errors.js`, `jobs.js`, `parking.js`, `phases.js`, `run-files.js`, `fs-json.js`, `config.js` | 검토 요약·결과 보고, 단계·연결 판정, 오류 설명, 작업 로그·ETA, 검토 대기, 단계 상수, 실행 폴더 파일 이름, JSON 원자적 입출력, 환경 변수 |

**화면**(`public/assets/`)도 같은 원칙이다: `state.js`(공유 상태 하나) ← `dom.js`, `net.js`, `session-client.js` ← 패널(`panel-*.js`, `progress.js`) ← `app.js`(시작점). 패널은 `app.js`를 부르지 않고 `hooks.render`로 갱신을 요청한다.

계획·검증·영수증·잠금·기준선, 그리고 pacing(429 이력에 맞춰 조절되는 읽기 간격)·재시도·429 쿨다운·자동 재개가 모두 여기 있다. 작업 상태는 파일이 정본이다(`runs/<id>/`, `data/jobs/*.jsonl`, `data/parking.json`).

### B. 원격 호출 (수행)

비공개 웹 API(`https://chatgpt.com/backend-api`)를 만지는 유일한 경로이며 두 조각이다.

- **`remote-ops.js` (앱·페이지 공용)** — 허용 op 목록, 파라미터·응답 형태 검증. DOM에 의존하지 않아 Node에서 테스트한다.
- **페이지 실행기 (chatgpt.com 안)** — 앱이 보낸 `{op, params}`를 자기 op→URL 표로만 요청으로 바꿔 **한 번에 하나씩** 수행하고 결과만 돌려준다. 판단하지 않는다.

앱은 원시 URL을 보내지 않고 페이지는 표에 없는 요청을 만들지 않는다. **양쪽 모두 임의 요청을 실행할 수 없다.** 인증은 페이지 자신의 로그인 세션을 쓰고 토큰은 앱으로 넘기지 않는다.

노출하는 기능은 좁게 고정한다: 대화 목록(활성·보관), 대화 1건 읽기, 소유 프로젝트 목록, 프로젝트별 대화 목록, 대화 변경(제목·보관·표시), 프로젝트 생성, 프로젝트 배치.

계약과 위험은 [../API_COMPATIBILITY.md](../API_COMPATIBILITY.md)에만 기록한다. API 관련 **유일한 유지 대상**이다.

### C. 분류 핸드오프 (외부)

별도 AI 채팅에서 수행한다. 이 저장소의 실행 파일이 아니다.

- 입력: 최소 분류 입력(`review.json`) + 압축된 판단 기준
- 출력: 삭제/보존/미결정·표준 제목·최종 프로젝트 제안(`proposal.json`)
- 저장소 코드는 이 출력을 **검증만** 한다(형식·해시·후보 전체성·제목 규칙). 제안은 승인이 아니다.

## 파일 계약 (누가 쓰고 누가 읽는가)

| 파일 | 쓰는 곳 | 읽는 곳 |
| --- | --- | --- |
| `data/state.json`(기준선) | `baseline.js`(만들기·확정), `checkpoint.js`(적용 뒤), `scan.js`(후보 없을 때) | `scan.js`, `web-views.js`, `brief.js` |
| `runs/<id>/inventory.json`·`catalog.json`·`review.json` | `scan.js`, `classification-review.js`, `web-decisions.js`(후속 실행) | `proposal-validation.js`, `decision-compile.js`, `checkpoint.js`, `web-views.js` |
| `runs/<id>/proposal.json` | AI 에이전트(`overhaul.js assemble` 포함) 또는 화면 붙여넣기 | `web-views.js`, `web-workflows.js` |
| `runs/<id>/reviewed-decisions.json` | `web-decisions.js` | `decision-compile.js`, `checkpoint.js`, `web-views.js`, `web-workflows.js` |
| `runs/<id>/plans/`·`routing.json`·`receipts/` | `decision-compile.js`, 적용 엔진 | `plan-set.js`, `project-routing.js`, `web-workflows.js` |
| `runs/<id>/report.json`·`report.md` | `web-workflows.js`(`finishRun`) | `web-views.js` |
| `runs/<id>/parking-meta.json`·`followup.json` | `web-decisions.js` | `web-workflows.js`(`settleParking`) |
| `data/parking.json` | `parking.js` | `web-views.js`, `web-decisions.js`, `brief.js` |
| `data/jobs/*.jsonl` | `jobs.js` | `web-views.js` |
| `data/rebaseline-last.json` | `web-workflows.js` | `web-views.js` |
| `.local/maintenance-web.json`(현재 실행 포인터, `phases.js` 단계) | `web-common.js`(`writePointer`) | `web-*`, `brief.js` |

파일 이름은 `run-files.js`에만 있다. 새 실행 파일을 추가하면 거기에 이름을 더하고 이 표를 고친다.

## 알려진 부채 (2026-09-25 점검)

- 루트가 평평해 파일이 약 47개다. 폴더로 나누면 import 경로가 전부 바뀌므로 필요해질 때 별도 변경으로 한다.
- 긴 함수 세 개가 남아 있다: `management.js`의 `runManagementWorkflow`(쓰기 엔진, 검증이 촘촘해 손대지 않았다), `proposal-validation.js`의 `validateClassificationProposals`, `relay-api.js`의 `createRelayBroker`.
- 실행 포인터와 `phase` 문자열은 세션 상태 API 뒤에 가려져 있을 뿐 구조가 옛것이다(`docs/REDESIGN.md`).
- 오류 설명(`errors.js`)은 메시지 정규식에 기댄다. 오류 코드를 던지는 방식으로 옮기면 더 견고하다.
- 화면 스크립트는 자동 시험이 없다(종단 간 시험은 API까지). 화면 논리를 바꿀 때는 `node dev/fake-server.js`로 직접 확인한다.

## 데이터와 코드의 분리

| 대상 | 위치 | Git |
| --- | --- | --- |
| 코드·테스트·기준 문서 | 저장소 | 추적 |
| 기준선 `state.json` | 데이터 폴더 | 제외 |
| 실행 산출물 `runs/` (후보 본문, 제안, 승인, 계획, 영수증) | 데이터 폴더 | 제외 |
| 분류체계 `classification-taxonomy.md` | 데이터 폴더 | 제외 |
| 세션 토큰·쿠키 | 브라우저 안에만 | 제외 |

기본 위치는 `<repo>/data/`이고 `--data-dir` 인자나 `.local/config.json`으로 바꾼다. 백업은 사용자의 백업 프로그램이 하며 **Git·GitHub는 쓰지 않는다.** 정리는 한 컴퓨터에서만 하고, 실행이 겹치는 것은 데이터 폴더 내 잠금 파일 하나로 막는다. 데이터 폴더를 옮겨 쓰게 되면 거기서 새로 스캔한다 — 충돌을 자동 병합하지 않는다.

## 유지하는 안전장치

- **rate limit 대응** — 전역 쿨다운, 지수 백오프, 요청 간 간격. 초기 개발에서 과다 요청으로 일시 차단을 겪었고, 2026-09-12 대량 적용에서도 `429`가 지속됐다. 반드시 유지한다.
- **변경 전후 검증** — 쓰기 직전 원격 상태를 다시 읽고, 쓰기 후 결과를 다시 확인한다. 응답의 성공 코드만 믿지 않는다.
- **확인 문구** — 파괴적 배치(삭제 포함)는 정확한 확인 문구가 일치해야 실행한다.
- **배치 크기 제한** — 계획 하나는 최대 25건이며 큰 프로젝트는 같은 프로젝트를 가리키는 타깃 여러 개로 나뉜다(총 600건).
- **빠른 검증의 한계 표시** — 전체 재수집을 생략한 기준선은 `verification: assume-quiet`로 표시하고 결과 화면이 그 사실을 알린다.
- **원본 대화 JSON은 읽기 전용** — 다운로드본은 해시로 변조를 감지한다.
- **모호한 쓰기 결과** — 프로젝트 생성처럼 응답이 실패해도 실제로는 반영됐을 수 있는 요청은 자동 재시도하지 않고 원격 목록을 다시 읽어 대조한다.

## 개발·시험

`node dev/fake-server.js`는 모의 ChatGPT 계정(`test/support/fake-chatgpt.js`, 429·무응답·지연 주입 가능)을 릴레이 브로커에 붙이고 임시 작업 폴더에서 서버를 띄운다. `test/e2e-flow.test.js`가 같은 서버를 자식 프로세스로 띄워 스캔→검토→적용→결과, 429 자동 재개, 검토 대기 확정을 끝까지 시험한다.

## 왜 이렇게 되어 있나

되돌리려 하기 전에 읽을 제약들이다.

- **내보내기 기능을 두지 않는다.** 이 도구는 정리 도구이고 백업 도구가 아니다. 전체 백업이 필요하면 외부 도구를 쓴다.
- **데이터는 저장소 안의 gitignore 폴더 + 설정으로 위치 지정.** `state.json`을 Git으로 공유하던 전제가 공개를 막고 복잡도를 키웠다. 사용자의 백업 방식에 개입하지 않는다.
- **Git 오케스트레이션을 쓰지 않는다.** 잠금·승인·진행 관리에 Git 태그나 PR을 쓰지 않는다. 로컬 잠금 파일 하나로 충분하다.
- **인증은 북마클릿 하나로 단일화.** 전용 Chrome 디버깅 포트 경로와 세션 JSON 파이프 경로는 폐기했다. 세션이 브라우저 밖으로 나가지 않는 구조가 보안상 더 낫다.
- **원격 호출 주체는 브라우저.** Node의 `/backend-api` 호출은 비브라우저 TLS 핑거프린트 때문에 차단된다(2026-09-09 관측). 우회하지 않고 호출 주체를 옮겼다. TLS 핑거프린트 위조, 브라우저 프로필·쿠키 직접 읽기, UI 대량 자동 조작은 배제한다.
- **분류는 저장소 밖에서.** 코드가 AI를 호출하지 않는다. 모델·요금·프롬프트 변화를 저장소가 따라가지 않아도 되고, 검증 로직만 유지하면 된다.
- **외부 프로젝트의 코드를 가져오지 않는다.** 비공개 API 계약을 확인할 때 다른 구현을 참고할 수는 있지만([../API_COMPATIBILITY.md](../API_COMPATIBILITY.md)), 코드를 복사하거나 동기화하지 않는다. 필요한 기능은 직접 쓴다.
