# 에이전트에게 설치·운영을 맡길 때

이 도구를 직접 설치하지 않고 코딩 에이전트(Claude Code, Codex 등)에게 맡기는 경우의 안내다.
사람이 직접 하는 단계별 설치는 [GETTING_STARTED.md](GETTING_STARTED.md)를 본다.

## 먼저 알아야 할 세 가지

**1. 에이전트가 대신할 수 없는 일이 있다.** ChatGPT 로그인 세션은 사용자의 브라우저 안에만
있어야 한다. 북마클릿 클릭은 **사람이 직접** 한다. 세션 JSON이나 토큰을 에이전트 대화에
붙여넣으라는 요구는 잘못된 요구다.

**2. 실제 ChatGPT 변경은 승인 후에만 일어난다.** 제목 변경·프로젝트 배치·삭제후보 이동(고급 옵션으로 삭제)은 화면에서
사용자가 결정하고 승인한 것만 적용된다. 에이전트가 알아서 대화를 정리하게 두는 도구가 아니다.

**3. 내 기록은 내 컴퓨터에만 남는다.** 실행 기록·삭제후보 목록·분류체계는 데이터 폴더에만 있고
저장소에 올라가지 않는다. 백업은 사용자의 백업 프로그램이 맡는다.

## 설치를 맡길 때 쓸 프롬프트

그대로 복사해 에이전트에게 주면 된다.

```text
이 저장소를 내 컴퓨터에 설치하고 첫 실행까지 준비해줘.

https://github.com/yimsemin/chatgpt-conversation-maintenance

먼저 README.md 와 docs/GETTING_STARTED.md 를 읽어. 그리고 AGENTS.md 를 읽어 —
이 저장소에서 에이전트가 지켜야 할 규칙이 거기 있다.

해줄 일:
1. 저장소를 클론하고 Node.js 24 이상이 있는지 확인한다. 없으면 설치 방법을 알려줘.
2. npm install 로 첫 설정을 한다.
3. npm test 와 npm run repo:check 가 통과하는지 확인한다.
4. 데이터 폴더 위치를 알려준다. 기본값(<저장소>/data/)을 그대로 쓸지,
   내 백업 프로그램이 감시하는 폴더로 바꿀지 물어봐.
5. 삭제 후보를 옮겨 둘 프로젝트를 어떻게 할지 물어봐(자동 · 이름을 정해 둔 프로젝트 · 옮기지 않고 표시만). 정하면 .local/config.json 의 "trash" 설정(docs/GETTING_STARTED.md 5단계)으로 적어줘. 프로젝트 주소나 ID는 적지 말고 이름만 써.
6. npm run app 으로 로컬 화면을 띄우고, 북마클릿 설치·클릭으로 연결한 뒤 조사 범위를 골라 "이 범위 확인"을 누르는 순서를 내가 따라 할 수 있게 안내해줘.

하지 말아야 할 일:
- 내 ChatGPT 세션 JSON 이나 토큰을 요구하거나 대화에 남기지 마. 그건 내가 브라우저에서
  북마클릿으로 직접 전달한다.
- 내 ChatGPT 대화를 읽거나 바꾸려고 시도하지 마. 스캔과 적용은 내가 화면에서 시작한다.
- data/ 나 .local/ 을 커밋하지 마.
- 내 브라우저 프로필이나 쿠키 파일을 직접 읽지 마.
```

## 첫 실행이 막히는 가장 흔한 두 가지

**연결이 안 된다.** 화면 오른쪽 위가 "ChatGPT 연결 끊김"이면 사용자가 chatgpt.com에 로그인한 탭에서 북마클릿을 눌러야 한다. 에이전트가 대신 할 수 없다([GETTING_STARTED.md](GETTING_STARTED.md) 7단계).

**계정 ID가 없다.** 세션 토큰에 ChatGPT 계정 ID가 있어야 한다. 없으면 인증 단계에서
`account ID` 오류가 난다. 실제로 확인된 동작 범위는 Business 워크스페이스 한 곳뿐이다.

## 운영을 맡길 때

분류 제안처럼 판단이 필요한 작업을 에이전트에게 맡길 수 있다. 그때는 이렇게 경계를 준다.

```text
유지관리 분류 제안을 해줘.

CLASSIFICATION_WORKFLOW.md 를 먼저 끝까지 읽어. 그리고 데이터 폴더의 분류체계
(classification-taxonomy.md)가 있으면 그것도 읽어 — 내가 정한 프로젝트 정의다.

`npm run brief`가 가리키는 현재 실행의 inventory.json 과 review.json 만 사용하고, 제안을
proposal.json 으로 작성한 다음 node workflow.js validate-proposal 로 검증해줘.
(맞는 프로젝트가 없으면 suggestedProjectName 을 null 로 두고, 확신이 없는 삭제 후보는
내가 삭제후보 프로젝트에서 직접 확인할 수 있게 그대로 delete 로 제안하고, 표준 제목이 아니면 삭제 후보에도 표준 제목을 suggestedNewTitle 로 제안해줘.)

제안은 승인이 아니다. 내가 확인할 때까지 reviewed: true 를 만들거나 적용을 실행하지 마.
```

**분류체계를 먼저 만들어 두는 편이 낫다.** 없으면 실행마다 프로젝트 경계가 흔들려 비슷한
프로젝트가 늘어난다. 형식은 [../templates/classification-taxonomy.example.md](../templates/classification-taxonomy.example.md)를 참고한다.

## 에이전트가 넘지 말아야 할 선

이 저장소의 [AGENTS.md](../AGENTS.md)에 전부 적혀 있고, 핵심은 다음과 같다.

- 세션 토큰·쿠키·브라우저 프로필을 읽거나 저장하지 않는다.
- 승인 없이 실제 ChatGPT 상태를 바꾸지 않는다.
- 변경 응답의 성공 코드만 믿지 않고 재조회로 검증한다.
- 비공식 API가 막혔을 때 TLS 핑거프린트 위조나 UI 대량 자동 조작으로 우회하지 않는다.
- `data/`·`.local/`을 커밋하지 않는다.
