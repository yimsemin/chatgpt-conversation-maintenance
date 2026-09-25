# ChatGPT 대화 유지관리

> **처음이신가요?** 설치부터 첫 정리까지 단계별로 → [시작하기 가이드](docs/GETTING_STARTED.md)
>
> **에이전트에게 설치를 맡기려면** → [에이전트 설치·운영 안내](docs/AGENT_SETUP.md)

로그인한 ChatGPT 대화를 컴퓨터에서 정리하는 개인용 도구다. 새 대화와 바뀐 대화만 선별하고, 삭제·제목·프로젝트를 사용자가 화면에서 직접 결정해 승인한 변경만 적용한다(AI 분류는 선택). 로그인 세션은 ChatGPT 페이지 밖으로 내보내지 않는다. 대화 원문도 데이터 폴더에만 두고 GitHub에 올리지 않는다.

**한 가지 예외:** 선택 경로인 외부 AI 분류를 쓰면 후보 대화의 **발췌본**(요청문에 넣는 `review.json` — 제목, 프로젝트명, 사용자 요청과 최종 응답의 앞뒤 일부)이 사용자가 직접 복사해 그 AI 서비스로 나간다. 자세한 범위는 [CLASSIFICATION_WORKFLOW.md](CLASSIFICATION_WORKFLOW.md)를 본다. 외부 AI를 쓰지 않고 화면에서 직접 결정하면 대화 내용은 이 컴퓨터를 벗어나지 않는다.

운영은 **한 컴퓨터에서만** 한다. 내 ChatGPT 계정의 정리 기록은 그 컴퓨터의 데이터 폴더에만 두고, 필요하면 내가 쓰는 백업 프로그램으로 동기화한다. **GitHub로는 동기화하지 않는다.** 이 저장소를 쓰는 사람은 각자 자기 계정을 자기 방식으로 관리한다 — 관리 기록이 저장소에 모이는 구조가 아니다.

이 프로젝트의 운영 목표는 다음과 같다.

- 관련성과 재사용성이 있는 대화는 적합한 하나의 ChatGPT 프로젝트에 둔다. 맞는 프로젝트가 없으면 새 프로젝트를 제안하고, 어디에도 맞지 않으면 프로젝트 없음이 정상이다.
- 재사용 가치가 없는 대화는 삭제 후보로 제안한다. 확신이 없으면 곧바로 지우지 않고 **검토 대기**(임시 보관 프로젝트)에 모아 사용자가 ChatGPT에서 직접 확인한 뒤 확정한다.
- 왜 이렇게 정리하는지(원본·프로젝트·대화 기록의 역할)는 [docs/GOALS.md](docs/GOALS.md)에 있다.
- 제목은 `핵심 대상·주제 — 실제 작업 또는 결과` 형식으로 표준화한다.
- 아카이브와 ChatGPT Memory는 사용자가 직접 관리한다.
- 유지관리는 사용자가 화면에서 시작하는 정기 정리(새로 생기거나 바뀐 대화만 후보로 삼음)를 기본으로 한다.

## 빠른 시작

Node.js 24 이상과, 세션에 계정 ID(`chatgpt_account_id`)가 있는 ChatGPT 워크스페이스 계정이 필요하다. 실계정 검증은 Business 워크스페이스 한 곳뿐이며(2026-08-10, [API_COMPATIBILITY.md](API_COMPATIBILITY.md)) Enterprise·Team·개인 계정은 확인되지 않았다.

```text
git clone https://github.com/yimsemin/chatgpt-conversation-maintenance.git
cd chatgpt-conversation-maintenance
npm install        # 로컬 커밋 훅 설정(런타임 의존성 없음)
npm test           # 자체 점검 (fail 0)
npm run repo:check # 민감 파일 점검
npm run app        # 127.0.0.1:8523 화면 열기 (macOS start-local.command, Windows start-local.cmd 더블클릭도 가능)
```

화면의 **"처음 시작하기"** 를 따른다: ① 북마클릿을 북마크바에 등록하고 chatgpt.com에서 눌러 연결 → ② 기준선 만들기 → ③ "새 대화 확인" → 분류 제안 → 검토 → "적용". 확인·기준선 만들기는 ChatGPT를 바꾸지 않는다. 각 단계와 문제 해결은 **[시작하기 가이드](docs/GETTING_STARTED.md)** 에 있다.

## 사용 흐름

화면은 **확인 → 제안 → 검토 → 적용 → 결과** 다섯 단계이며 맨 위가 지금 할 일과 진행 상태를 알려 준다. 화면을 닫아도 작업은 서버에서 계속되고 다시 열면 복원된다(`data/jobs/`).

1. **확인** — 마지막 확인 이후 새로 생기거나 바뀐 대화를 후보로 모은다(ChatGPT의 모든 대화 목록을 읽어 기준선과 비교하며 2~3분 걸린다). 제목 형식만 어긋난 대화는 한 번 후보로 나온 뒤 보류 목록으로 빠진다.
2. **제안** — 화면이 알려 주는 한 문장을 이 저장소를 연 AI 에이전트에게 전달하면 `proposal.json`이 만들어진다. 코드가 AI를 호출하지 않는다. 결과 JSON을 붙여넣어도 된다.
3. **검토** — "삭제 N · 이동 N · 제목 변경 N" 요약과 프로젝트별 증감을 보고 예외 항목만 고친다. 삭제 후보는 곧바로 지우지 않고 **검토 대기**(임시 보관 프로젝트)에 둘 수 있다.
4. **적용** — 버튼 한 번. 25건 단위로 제목 변경·삭제·프로젝트 배치를 하고 건마다 재조회로 검증한다. 429·무응답은 기다렸다가 자동으로 이어 간다. 삭제는 확인 창을 한 번 더 거친다.
5. **결과** — 바뀐 내용과 **직접 하실 일**(비게 된 프로젝트, 프로젝트에서 직접 빼야 하는 대화)을 보여 주고 `runs/<id>/report.md`로 남긴다.

**검토 대기**는 ChatGPT에서 직접 확인한 뒤 화면에서 삭제·복원을 확정한다. 화면 위쪽의 **처음이세요?** 안내가 5단계와 용어(후보·기준선·연결 등)를 풀이한다. **고급**에는 ChatGPT 상태 다시 맞추기, 모든 대화 본문 받기, 연결 방법, 작업 폴더, 최근 작업이 있고 이전 편집 화면은 `/legacy`에 남아 있다. 실패는 화면 맨 위에 원인과 조치로 나오며 `오류 복사`는 토큰·대화 본문·개인 경로를 뺀 정보만 복사한다.

## 중요한 전제: 비공식 API

이 도구는 로그인한 ChatGPT 웹 앱의 `https://chatgpt.com/backend-api`를 쓴다. 문서화된 공식 API가 아니어서 예고 없이 바뀔 수 있고, 공식 OpenAI API 키로 ChatGPT 사이드바 대화나 프로젝트를 관리할 수 있다는 뜻도 아니다. 자신의 데이터에만 쓰고 계정 약관을 확인할 책임은 사용자에게 있으며, 과도한 요청은 속도 제한을 일으킨다. 공식 제품이 아니다.

Node에서 `/backend-api`를 직접 호출하면 TLS 핑거프린트 때문에 403이 나오므로 HTTP 수행만 chatgpt.com 페이지(북마클릿)로 옮겼다. 앱은 허용된 `{op, params}`만 보내고 세션 토큰은 페이지 밖으로 나오지 않는다. TLS 위조, 브라우저 프로필·쿠키 직접 읽기, UI 대량 자동 조작으로 우회하지 않는다. 장애 시에는 [API 호환성 기록](API_COMPATIBILITY.md)의 대조 순서를 따르고 대량 재시도하지 않는다(프로젝트 생성은 실패 응답이어도 만들어졌을 수 있어 목록을 먼저 확인한다).

## 자동화의 경계

삭제·제목 변경·프로젝트 생성과 배치는 자동 승인하지 않는다. 제안은 변경 권한이 아니며 원격 변경에는 사용자 승인, 확인 문구, 로컬 잠금이 모두 필요하다. 승인된 계획에는 상태 해시와 사전 조건이 묶이고 변경 전후 원격 상태를 다시 확인한다. 아카이브와 Memory는 다루지 않는다.

## 데이터와 백업

Git에는 코드·테스트·운영 문서만 둔다. 기준선(`state.json`), 실행 산출물(`runs/`), 작업 로그, 검토 대기, 잠금, 보류 목록, 분류체계(`classification-taxonomy.md`, 형식은 [templates/](templates/classification-taxonomy.example.md))는 데이터 폴더(기본 `<repo>/data/`, `--data-dir` 또는 `.local/config.json`의 `dataDir`)에만 두며 `.gitignore`와 `npm run repo:check`가 막는다. 세션·쿠키·환경 파일은 어디에도 저장하지 않는다.

정리는 **한 컴퓨터에서만** 한다. 백업·동기화는 사용자의 백업 프로그램이 하고 GitHub는 그 경로에 쓰지 않는다. 다른 컴퓨터에서는 새로 스캔해서 시작한다. 공개 전 점검은 [docs/PRIVACY.md](docs/PRIVACY.md).

**한 가지 예외:** 외부 AI 분류를 쓰면 후보 대화의 발췌본(`review.json`)이 사용자가 직접 복사해 그 서비스로 나간다([CLASSIFICATION_WORKFLOW.md](CLASSIFICATION_WORKFLOW.md)). 쓰지 않으면 대화 내용은 이 컴퓨터를 벗어나지 않는다.

## 직접 쓰는 로컬 명령

원격을 건드리지 않는 점검·진단용이다.

```text
npm run brief                                        # 상태와 다음 행동(사용자/에이전트) 요약
node maintenance-lock.js status|release              # 잠금 확인·해제(비정상 종료 뒤에만)
node hold-list.js list|remove <id>|clear             # 보류 목록
node workflow.js validate-proposal <inventory.json> <proposal.json>
curl -s http://127.0.0.1:8523/relay/trace            # 릴레이 경계 진단
node dev/fake-server.js                              # 모의 ChatGPT로 흐름 시험(실제 데이터 미사용)
node overhaul.js slice|validate-cards|assemble ...   # 대량 재분류용 카드 도구
```

## 문서 안내

| 문서 | 내용 |
| --- | --- |
| [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) | 비개발자용 설치·사용 가이드, 문제 해결 |
| [docs/AGENT_SETUP.md](docs/AGENT_SETUP.md), [AGENTS.md](AGENTS.md) | 에이전트에게 맡길 때, 에이전트의 시작 순서와 안전 경계 |
| [docs/GOALS.md](docs/GOALS.md) | 왜 이렇게 정리하는가 |
| [CLASSIFICATION_WORKFLOW.md](CLASSIFICATION_WORKFLOW.md) | 삭제·제목·프로젝트 판단 기준, 제안·승인 파일 형식 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/PITFALLS.md](docs/PITFALLS.md) | 구조·파일 계약·알려진 부채, 반복된 함정 |
| [API_COMPATIBILITY.md](API_COMPATIBILITY.md) | 확인된 비공식 API 계약과 장애 대응 |
| [docs/REDESIGN.md](docs/REDESIGN.md), [docs/OVERHAUL.md](docs/OVERHAUL.md) | 화면·세션 설계 원칙, 전수 재정비 절차 |
| [docs/GIT.md](docs/GIT.md), [docs/PRIVACY.md](docs/PRIVACY.md) | 커밋·병합 규칙, 공개 전 점검 |

분류 규칙이나 API 계약을 다른 문서에 복사하지 않는다. 문서와 구현이 다르면 코드·테스트·원격 상태를 대조해 해당 문서를 함께 고친다.

## 현재 한계

- 북마클릿 릴레이는 완전 무인이 아니다. 로그인 만료, MFA, 내부 API 변경에는 사람이 개입해야 한다.
- 소유 프로젝트만 조회한다. 프로젝트 파일·지침·Library·Memory·연결 앱의 영향은 대화 정리로 없앨 수 없다.
- macOS·Windows 단위·저장소 검사는 CI에서 자동화되지만 실계정 인증은 각 컴퓨터에서 따로 확인해야 한다.
