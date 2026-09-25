# Git 워크플로

커밋·푸시·병합을 하기 직전에만 읽는다. 개인용 저장소이며 공개 가능한 상태다(공개 전환 자체는 사용자 결정).

## 원칙

`main`은 항상 테스트 통과 상태다. 작업은 브랜치에서 하고, 끝나면 **PR 없이 로컬에서 `--ff-only`로 병합**한다. **푸시는 사용자의 명시적 승인이 있을 때만** 한다.

## 브랜치

- 작업마다 브랜치 하나: `feat/`, `fix/`, `docs/`, `refactor/`, `chore/` + kebab-case 슬러그. 오래 끌면 `main`을 병합해 따라간다.
- `main` 직접 커밋은 `.githooks/pre-commit`이 막는다. 사용자가 "바로 고쳐"처럼 사소한 즉시 수정을 요청했을 때만 `ALLOW_MAIN_COMMIT=1 git commit ...`으로 우회한다.
- **병렬 대화방은 워크트리로 분리한다.** 작업 디렉터리를 공유하면 한 세션의 변경이 다른 세션의 커밋에 섞인다.
  ```bash
  git worktree add ../chatgpt-archive-<슬러그> -b feat/<슬러그>
  # 끝나면 원본 디렉터리에서 병합한 뒤
  git worktree remove ../chatgpt-archive-<슬러그>
  ```
  같은 디렉터리를 공유해야 하면 커밋 직전에 `git branch`와 `git status`로 확인한다. 남의 브랜치는 건드리지 않는다.

## 커밋

- 논리 단위로 나눈다. 관련 없는 변경을 한 커밋에 섞지 않는다.
- 모든 커밋은 `npm test`, `npm run repo:check`, `git diff --check` 통과 상태여야 한다.
- 메시지는 한국어 명사구 요약이며 필요할 때만 본문을 붙인다. 유형은 브랜치 접두어가 나타내므로 Conventional 접두어는 쓰지 않는다.
- AI 생성 표식이나 co-author 트레일러(`Generated with Claude Code`, `Co-Authored-By: Claude`)를 넣지 않는다. `.githooks/commit-msg`가 이런 줄을 제거한다(`core.hooksPath=.githooks`, `npm install` 시 자동 설정). `.claude/settings.json`의 `attribution`도 비워 둔다.
- `data/`, `.local/`, 세션·토큰·쿠키·대화 본문·개인 절대경로는 커밋하지 않는다. `repo:check`가 막지만 `git status --ignored`로도 확인한다.

## 병합 (PR 없음)

```bash
git switch main && git merge --ff-only <브랜치>   # 필요하면 먼저 브랜치에서 main 을 병합
git branch -d <브랜치>
```

- 의미 단위 커밋은 그대로 두고, 잡다한 WIP만 `git merge --squash`로 묶는다.
- 다음은 병합하지 말고 사용자에게 먼저 알린다: 실제 ChatGPT 원격 동작에 영향을 주는 변경, 인증·보안·`repo-check.js` 관련 변경, 대량 삭제·파일 이동이 핵심인 변경.
- **자동화가 여는 PR은 허용한다**(예: Dependabot 버전 업데이트). 사람이 검토한 뒤 병합한다. 사람이 하는 일반 작업에는 PR을 쓰지 않는다.

## 푸시

- **명시적 승인이 있을 때만 푸시한다.** 승인은 그 순간에만 유효하며 이후 푸시로 이어지지 않는다.
- CI(`Verify`, macOS·Windows)는 push와 pull_request에서 돌므로, 푸시 뒤 결과를 확인하고 실패하면 알린다.
- `main`과 공유 브랜치에 force-push·히스토리 재작성 금지. 지금까지 사용자 승인 아래 두 번 수행했다.
  - 2026-08-30: `state.json` 히스토리 세탁([PRIVACY.md](PRIVACY.md) 1절)
  - 2026-09-12: 공개 전 커밋 정리 — 전체 히스토리를 의미 단위 4개로 압축
  - 2026-09-25: 75개 커밋을 의미 단위 12개로 압축하고 원격 `main`을 그 이력으로 덮어쓰기로 했다(푸시는 별도 승인). 각 묶음의 마지막 커밋 트리를 그대로 써서 파일 내용은 바뀌지 않았고, 묶음마다 시험을 통과했다. 원격의 쓸모없는 브랜치(`chore/dedupe-shared-utils`, `feat/agent-brief`)도 함께 정리한다.
- 이후 추가 히스토리 재작성은 하지 않으며, 사용자가 명시적으로 다시 허용하지 않는 한 제안도 하지 않는다.
- 재작성 절차: 작업 브랜치에서 커밋을 마친 뒤 백업 태그를 만들고, 묶음별 마지막 트리로 `git commit-tree`를 이어 새 이력을 만든다. 최종 트리가 같은지·묶음마다 `npm test`와 `repo:check`가 통과하는지 확인한 뒤, 사용자 승인 아래 `git push --force-with-lease`를 쓴다.

## 하지 않는 것

- 사용자의 명시적 요청·승인 없이 실제 ChatGPT 원격 변경을 실행하거나 그 결과를 커밋한다.
- **저장소를 공개로 전환한다.** 사용자가 명시적으로 요청할 때만 `gh repo edit --visibility public`을 실행한다. 제안은 할 수 있다.
- 다른 프로젝트의 코드를 복사해 넣는다. `API_COMPATIBILITY.md`가 참고로 연결한 저장소들도 계약 확인에만 쓴다.
- 되돌리기 어려운 Git 작업(브랜치 강제 삭제, 태그 삭제, reset --hard on shared refs)을 사용자 확인 없이 한다.
