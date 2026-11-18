# 저장소 Git·릴리스 규칙

## 브랜치와 외부 반영

- `develop`에서 작업 브랜치를 만들고 검증 뒤 로컬에서 `--ff-only`로 병합한다. 일반 작업은 PR 없이 병합한다. Dependabot 등 자동화 PR은 검토 후 병합할 수 있다. `main`은 릴리스한 안정 버전이다.
- `main`과 `develop` 직접 커밋은 훅으로 막는다. 릴리스 커밋과 사용자가 즉시 수정을 요청한 사소한 작업에는 기존 `ALLOW_PROTECTED_COMMIT=1` 예외를 쓴다.
- 병렬 작업은 워크트리로 분리한다. 푸시 전 같은 작업의 후속 수정은 기존 커밋에 합친다.
- 원격 동작, 인증·보안, 민감정보 검사, 대량 삭제·이동에 영향을 주는 변경은 병합 전에 사용자에게 알린다. 푸시·릴리스·공개 전환·공유 이력 재작성은 사용자가 해당 작업을 명시적으로 요청하거나 승인한 뒤 진행한다. 푸시 승인은 해당 작업에만 적용한다.

## 커밋 검사

- `npm install`의 `prepare`가 `.githooks`를 활성화한다. 훅이 작성자와 커밋터의 GitHub noreply 이메일, 영어 단어가 포함된 Conventional Commits 제목을 검사한다. 예시는 `docs(readme): clarify first run`이다. 커밋 메시지는 AI 생성 표식 없이 작성한다.
- 검증 명령은 `npm test`, `npm run repo:check`, `git diff --check`다. 푸시 후 macOS·Windows의 `Verify` 결과를 확인한다.
- Git에는 코드·테스트·운영 문서와 합성 예시를 둔다. 실제 대화 데이터와 인증정보의 보관 위치는 [AGENTS.md](../AGENTS.md#데이터와-민감정보)를 따른다.

## 변경 이력

사용자가 알아차릴 기능·동작·지원 환경·버그 수정·보안 변경은 같은 커밋의 `CHANGELOG.md` `[Unreleased]`에 적는다. 문서·테스트·리팩터링·CI 변경은 Git 이력에서 확인한다. `CHANGELOG.md`의 릴리스 절을 GitHub Release와 앱의 업데이트 내역에 그대로 사용한다.

- 필요한 절만 `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security` 순서로 둔다.
- 항목은 `- **제목.** 설명` 형식으로 기능당 하나, 200자 이내로 쓴다. 사용자가 보게 될 결과를 한두 문장으로 적고 같은 기능의 후속 작업은 기존 항목에 합친다.
- 북마클릿 실행기나 릴레이 계약을 바꾸면 제품 버전과 별도로 `RELAY_VERSION`을 갱신한다. 북마클릿 재설치나 기존 데이터 이전이 필요하면 `Changed`에 방법을 적는다.

## 릴리스

1. 승인과 깨끗한 `develop` 작업 트리를 확인한다. `[Unreleased]`에서 중복을 정리한다.
2. `node src/release-notes.js release <X.Y.Z>`로 변경 이력과 패키지 버전을 함께 갱신한다. `Added`가 있으면 최소 minor를 올린다.
3. 커밋 검사를 실행한 뒤 릴리스 파일 두 개만 `develop`에 커밋한다. `main`에 `develop`을 `--ff-only`로 반영한다.
4. 패키지 버전·최신 변경 이력과 같은 `vX.Y.Z` 태그를 만들고 승인 범위에서 브랜치와 태그를 푸시한다. `node src/release-notes.js notes <X.Y.Z>`의 출력을 GitHub Release 본문으로 쓴다. 배포 소스는 `main`이며 Release 첨부 파일은 쓰지 않는다.

## 공개 전 점검

- 전체 Git 이력과 추적 파일에서 `data/`, `.local/`, 대화 제목·내용, 개인 경로, 프로젝트 주소·ID, 인증정보가 없는지 확인한다. `repo:check`와 무시 대상 목록을 함께 점검한다.
- 새 클론에서 `npm install`, `npm test`, 앱 실행이 개인 데이터 없이 동작하는지 확인한다.
