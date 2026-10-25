# Git 워크플로

커밋·푸시·병합을 하기 직전에만 읽는다. 공개 전환 전 점검은 맨 아래 "공개 전 점검"이다.

## 원칙

- `main`: 릴리스된 안정 버전만 있다. 사용자는 `main`을 받아 쓴다(GitHub 기본 브랜치). 릴리스 때만 `develop`에서 `--ff-only`로 갱신한다.
- `develop`: 개발 중인 통합 브랜치. 항상 테스트 통과 상태다.
- 작업은 `develop`에서 분기한 브랜치에서 하고, 끝나면 **PR 없이 로컬에서 `--ff-only`로 `develop`에 병합**한다. **푸시는 사용자의 명시적 승인이 있을 때만** 한다.

## 브랜치

- 작업마다 브랜치 하나: `feat/`, `fix/`, `docs/`, `refactor/`, `chore/` + kebab-case 슬러그. 오래 끌면 `develop`을 병합해 따라간다.
- `main`·`develop` 직접 커밋은 `.githooks/pre-commit`이 막는다. 릴리스 커밋과, 사용자가 "바로 고쳐"처럼 사소한 즉시 수정을 요청했을 때만 `ALLOW_PROTECTED_COMMIT=1 git commit ...`으로 우회한다.
- **병렬 대화방은 워크트리로 분리한다.** 작업 디렉터리를 공유하면 한 세션의 변경이 다른 세션의 커밋에 섞인다.
  ```bash
  git worktree add ../chatgpt-archive-<슬러그> -b feat/<슬러그> develop
  # 끝나면 원본 디렉터리에서 병합한 뒤
  git worktree remove ../chatgpt-archive-<슬러그>
  ```
  같은 디렉터리를 공유해야 하면 커밋 직전에 `git branch`와 `git status`로 확인한다. 남의 브랜치는 건드리지 않는다.

## 커밋

- 논리 단위로 나눈다. 관련 없는 변경을 한 커밋에 섞지 않는다.
- **같은 목적의 후속 수정은 새 커밋으로 쌓지 않고 직전 커밋에 `--amend`(또는 squash)한다.** 오타·누락·문구 보완처럼 같은 작업의 연장이면 합친다. 푸시 전 커밋은 묻지 않고 합쳐도 된다. 히스토리는 작업 단위마다 커밋 하나가 되도록 깔끔하게 유지한다.
- 모든 커밋은 `npm test`, `npm run repo:check`, `git diff --check` 통과 상태여야 한다.
- 사용자에게 보이는 변경은 **같은 커밋에서** `CHANGELOG.md`의 `## [Unreleased]`도 고친다(관련 항목이 있으면 새 줄이 아니라 그 항목을 고친다). 내부 변경(리팩터링·테스트·문서·CI)은 고치지 않는다. 작성 기준은 [RELEASE_NOTES.md](RELEASE_NOTES.md)다.
- **커밋 이메일은 GitHub noreply 주소(`<id>+<계정>@users.noreply.github.com`)만 쓴다.** 저장소마다 `git config --local user.email`로 설정한다. `.githooks/pre-commit`이 다른 주소의 커밋을, `.githooks/pre-push`가 그런 커밋의 푸시를, `npm run repo:check`가 이력 전체의 위반을 막는다. GitHub 계정 설정의 "Keep my email addresses private"와 "Block command line pushes that expose my email"도 켠다.
- 메시지는 **영어를 기본**으로 쓰고(한글이 섞여도 되지만 한글로만 쓰면 안 된다) **Conventional Commits 접두어를 반드시** 붙인다: `<type>(<선택 scope>): <소문자 명령형 요약>` (예: `feat(review): add per-item apply toggle`). type은 `feat` `fix` `docs` `refactor` `perf` `test` `build` `ci` `chore` `style` `revert` 중 하나다. 요약은 72자 안쪽, 끝에 마침표를 찍지 않고, 필요할 때만 본문을 붙인다. `.githooks/commit-msg`가 접두어와 "영어 단어 포함 여부"를 검사해 어긋나면 커밋을 거부한다(`Merge`·`Revert`로 시작하는 자동 메시지는 통과).
- AI 생성 표식이나 co-author 트레일러(`Generated with Claude Code`, `Co-Authored-By: Claude`)를 넣지 않는다. `.githooks/commit-msg`가 이런 줄을 제거한다(`core.hooksPath=.githooks`, `npm install` 시 자동 설정).
- `data/`, `.local/`, 세션·토큰·쿠키·대화 본문·개인 절대경로는 커밋하지 않는다. `repo:check`가 막지만 `git status --ignored`로도 확인한다.

## 병합 (PR 없음)

```bash
git switch develop && git merge --ff-only <브랜치>   # 필요하면 먼저 브랜치에서 develop 을 병합
git branch -d <브랜치>
```

- 의미 단위 커밋은 그대로 두고, 잡다한 WIP만 `git merge --squash`로 묶는다.
- 다음은 병합하지 말고 사용자에게 먼저 알린다: 실제 ChatGPT 원격 동작에 영향을 주는 변경, 인증·보안·`src/repo-check.js` 관련 변경, 대량 삭제·파일 이동이 핵심인 변경.
- **자동화가 여는 PR은 허용한다**(예: Dependabot 버전 업데이트). 사람이 검토한 뒤 병합한다. 사람이 하는 일반 작업에는 PR을 쓰지 않는다.

## 푸시

- **명시적 승인이 있을 때만 푸시한다.** 승인은 그 순간에만 유효하며 이후 푸시로 이어지지 않는다.
- CI(`Verify`, macOS·Windows)는 push와 pull_request에서 돌므로, 푸시 뒤 결과를 확인하고 실패하면 알린다.
- `main`·`develop`과 공유 브랜치에 force-push·히스토리 재작성은 **사용자가 그 대화에서 명시적으로 요청했을 때만** 한다. 에이전트가 먼저 제안하거나 스스로 시작하지 않는다(푸시 전 커밋의 amend는 재작성이 아니다).
- 재작성 절차: 작업 브랜치에서 커밋을 마친 뒤 백업 태그를 만들고, 묶음별 마지막 트리로 `git commit-tree`를 이어 새 이력을 만든다. 최종 트리가 같은지·묶음마다 `npm test`와 `repo:check`가 통과하는지 확인한 뒤, 사용자 승인 아래 `git push --force-with-lease`를 쓴다.

## 버전과 릴리스

- 버전은 세 곳에서 같아야 한다: `package.json`(`X.Y.Z`), `CHANGELOG.md` 최신 릴리스, 태그(`vX.Y.Z`). `npm run repo:check`가 앞의 둘의 일치를 검사한다. 앱 화면의 버전은 `package.json`을 읽는다. SemVer를 따른다.
- 북마클릿 호환은 제품 버전과 따로 `src/app-version.js`의 `RELAY_VERSION`(`relay-X.Y.Z`)이 정한다. 북마클릿 실행기나 릴레이 계약을 바꿀 때만 올리며, 올린 릴리스의 CHANGELOG `Changed`에 "북마클릿 재설치 필요"를 쓴다.
- `data/`의 파일 형식이 바뀌는 릴리스는 CHANGELOG `Changed`에 그 사실과 이어받는 방법을 쓴다.
- 릴리스 절차:
  1. `develop`이 최신이고 작업 트리가 깨끗한지 확인한다. `[Unreleased]`에서 같은 이야기를 두 번 하는 항목을 합치고 `Changed`·`Fixed` 구분을 점검한다.
  2. `node src/release-notes.js release <X.Y.Z>`가 CHANGELOG 승격과 `package.json` 버전 갱신을 한다. `Added`가 있는데 minor 이상을 올리지 않으면 거부한다.
  3. `npm test`, `npm run repo:check`, `git diff --check`를 실행하고 `ALLOW_PROTECTED_COMMIT=1 git commit -m "chore: release vX.Y.Z"`로 `develop`에 커밋한다. 릴리스 커밋에는 위 두 파일 외의 변경을 섞지 않는다.
  4. `git switch main && git merge --ff-only develop`으로 `main`을 갱신한다(`main`에는 직접 커밋하지 않으므로 항상 fast-forward다).
  5. 태그와 GitHub Release를 만든다. Release는 첨부 파일 없이 릴리스 노트만 싣는다(소스는 `main`이 곧 배포본이다).
     ```bash
     git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin main develop vX.Y.Z
     node src/release-notes.js notes X.Y.Z | gh release create vX.Y.Z --verify-tag --title "vX.Y.Z" --notes-file -
     ```
- 사용자는 `main`을 받는다. 설치는 `git clone`, 업데이트는 `git pull --ff-only`다([GETTING_STARTED.md](GETTING_STARTED.md)). `data/`와 `.local/`은 Git 밖이라 업데이트가 건드리지 않는다.

## 하지 않는 것

- 사용자의 명시적 요청·승인 없이 실제 ChatGPT 원격 변경을 실행하거나 그 결과를 커밋한다.
- 사용자의 릴리스 요청 없이 `main`을 갱신하거나 태그·GitHub Release를 만든다. 릴리스를 요청하면 위 "릴리스 절차" 전체(푸시 포함)를 요청한 것으로 본다.
- **저장소를 공개로 전환한다.** 사용자가 명시적으로 요청할 때만 `gh repo edit --visibility public`을 실행한다. 제안은 할 수 있다.
- 다른 프로젝트의 코드를 복사해 넣는다. `API_COMPATIBILITY.md`가 참고로 연결한 저장소들도 계약 확인에만 쓴다.
- 되돌리기 어려운 Git 작업(브랜치 강제 삭제, 태그 삭제, reset --hard on shared refs)을 사용자 확인 없이 한다.

## 공개 전 점검

공개 전환 전에 아래를 확인한다. 전환 자체는 점검이 끝나도 에이전트가 알아서 하지 않고 사용자가 명시적으로 요청할 때만 한다(위 "하지 않는 것").

### 공개 시점의 저장소 내용

**있어야 하는 것**: 코드, 테스트, `docs/`, 기준 문서(`AGENTS.md`, `README.md`, `API_COMPATIBILITY.md`, `CLASSIFICATION_WORKFLOW.md`), `templates/`, `.gitignore`의 `/data/`

**없어야 하는 것**: `data/`, `.local/`, 세션·쿠키·브라우저 프로필 파일, 대화 제목·프로젝트명이 담긴 파일, ChatGPT 프로젝트 주소·ID(데이터 폴더의 `known-projects.json`은 Git 밖이라 예외)

### 공개 직전 확인

- [ ] `npm run repo:check` 통과
- [ ] `npm test` 통과
- [ ] `git status --short --ignored`에 추적된 무시 대상 없음
- [ ] `git log --all --name-only --pretty=format:` 에 `data/`·`.local/`·세션 파일 없음
- [ ] 새 클론에서 `npm install` → `npm test` → `npm run app`이 개인 데이터 없이 동작

### 상시 보장되는 것

- `src/repo-check.js`가 `os.homedir()` 기준 개인 절대경로와 비밀 형태를 동적으로 검사한다(테스트 픽스처는 합성 데이터만 쓴다).
- 실행 산출물·삭제후보 목록·분류체계는 데이터 폴더에만 있고 `.gitignore`와 `npm run repo:check`가 이중으로 막는다.
- 데이터 폴더 규약·계정 요건·비공식 API 한계는 [GETTING_STARTED.md](GETTING_STARTED.md), README에 있다.

### 참고

- 커밋 메시지에 AI 생성 표식·co-author 트레일러를 넣지 않는다. `.githooks/commit-msg`가 제거한다.
