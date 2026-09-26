# 공개 전 점검

이 저장소를 공개로 전환하기 전에 확인할 것.

## 남은 사용자 결정

- [ ] **저장소 공개 전환** (`gh repo edit --visibility public`) — **사용자가 명시적으로 요청할 때만 실행한다.** 점검이 끝나도 에이전트가 알아서 전환하지 않는다.

## 공개 시점의 저장소 내용

**있어야 하는 것**: 코드, 테스트, `docs/`, 기준 문서(`AGENTS.md`, `README.md`, `API_COMPATIBILITY.md`, `CLASSIFICATION_WORKFLOW.md`), `templates/`, `.gitignore`의 `/data/`

**없어야 하는 것**: `data/`, `.local/`, 세션·쿠키·브라우저 프로필 파일, 대화 제목·프로젝트명이 담긴 파일, ChatGPT 프로젝트 주소·ID(데이터 폴더의 `src/known-projects.json`은 Git 밖이라 예외)

## 공개 직전 확인

- [ ] `npm run repo:check` 통과
- [ ] `npm test` 통과
- [ ] `git status --short --ignored`에 추적된 무시 대상 없음
- [ ] `git log --all --name-only --pretty=format:` 에 `data/`·`.local/`·세션 파일 없음
- [ ] 새 클론에서 `npm install` → `npm test` → `npm run app`이 개인 데이터 없이 동작

## 이미 처리한 것

- **개인 정보 하드코딩** — `src/repo-check.js`가 `os.homedir()` 기준으로 개인 절대경로를 동적 검사한다. 추적 코드·테스트 픽스처 전수 검색 결과 개인 절대경로·실제 대화 제목·프로젝트명 없음(합성 데이터만 사용).
- **사용자 데이터 격리** — 실행 산출물·삭제후보 목록·분류체계는 데이터 폴더에만 있고 `.gitignore`와 `npm run repo:check`가 이중으로 막는다.
- **사용자 안내** — [GETTING_STARTED.md](GETTING_STARTED.md), [AGENT_SETUP.md](AGENT_SETUP.md), README에 데이터 폴더 규약·계정 요건·비공식 API 한계를 담았다.

## 참고

- 모든 커밋 author가 개인 이메일(`<personal-email>`)이다. 공개해도 무방하다고 판단했다. 원치 않으면 이후 커밋부터 별도 identity를 쓴다.
- 커밋 메시지에 AI 생성 표식·co-author 트레일러를 넣지 않는다. `.githooks/commit-msg`가 제거한다.
