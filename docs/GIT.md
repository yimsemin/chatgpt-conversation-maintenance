# 저장소 Git·릴리스 규칙

## 브랜치와 외부 반영

- `develop` 없이 `main`만 쓴다. 브랜치·커밋·병합의 공통 규칙은 [AGENTS.md의 공통 작업 규칙](../AGENTS.md#git)을 따르고, 이 문서는 이 저장소에만 해당하는 것을 정한다.
- 원격 동작, 인증·보안, 민감정보 검사, 대량 삭제·이동에 영향을 주는 변경은 병합 전에 사용자에게 알린다. 푸시·릴리스·공개 전환·공유 이력 재작성은 사용자가 해당 작업을 명시적으로 요청하거나 승인한 뒤 진행한다. 푸시 승인은 해당 작업에만 적용한다.

## 커밋 검사

- `npm install`의 `prepare`가 `.githooks`를 활성화한다. 훅이 GitHub noreply 이메일과 영어 Conventional Commits 제목(`ysm:commit-lang=en`)을 검사한다. 예시는 `docs(readme): clarify first run`이다.
- 검증 명령은 `npm test`, `npm run repo:check`, `git diff --check`다. PR을 연 뒤와 병합한 뒤 macOS·Windows의 `Verify` 결과를 확인한다.
- Git에는 코드·테스트·운영 문서와 합성 예시를 둔다. 실제 대화 데이터와 인증정보의 보관 위치는 [AGENTS.md](../AGENTS.md#데이터와-민감정보)를 따른다.

## 변경 이력

사용자가 알아차릴 기능·동작·지원 환경·버그 수정·보안 변경은 같은 커밋의 `CHANGELOG.md` `[Unreleased]`에 적는다. 문서·테스트·리팩터링·CI 변경은 Git 이력에서 확인한다. `CHANGELOG.md`의 릴리스 절을 GitHub Release와 앱의 업데이트 내역에 그대로 사용한다.

- 필요한 절만 `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security` 순서로 둔다.
- 항목은 `- **제목.** 설명` 형식으로 기능당 하나, 200자 이내로 쓴다. 사용자가 보게 될 결과를 한두 문장으로 적고 같은 기능의 후속 작업은 기존 항목에 합친다.
- `RELAY_VERSION`은 제품 버전과 따로 `relay-MAJOR.MINOR.PATCH`로 관리한다. 북마클릿 실행기나 릴레이 계약을 바꾸면 `MAJOR.MINOR`를 올린다(연결 검사는 이 값이 같아야 통과하는 엄격한 일치이고 재설치가 필요하다). 북마클릿의 이름·안내 문구처럼 겉모습만 바뀌면 `PATCH`만 올린다(연결은 유지되고 화면이 새 북마클릿을 안내만 한다). 재설치나 기존 데이터 이전이 필요하면 `Changed`에 방법을 적는다.
- 재설치를 줄이도록 실행기(`public/bookmarklet.html`)는 요청을 받아 `fetch`하고 결과를 돌려주는 전달 역할만 맡기고, 새 기능은 원격 op(`src/remote-ops.js`)와 앱 쪽에서 처리한다. chatgpt.com의 CSP가 외부 스크립트와 `eval`을 막으므로 실행기를 앱에서 내려받는 방식은 쓸 수 없다.

## 릴리스

1. 승인과 깨끗한 `main` 작업 트리를 확인한다. `[Unreleased]`에서 중복을 정리한다.
2. `chore/release-vX.Y.Z` 브랜치에서 `node src/release-notes.js release <X.Y.Z>`로 변경 이력과 패키지 버전을 함께 갱신하고 릴리스 파일 두 개만 `chore(release): vX.Y.Z`로 커밋한다. `Added`가 있으면 최소 minor를 올린다.
3. 커밋 검사가 통과하면 PR을 올려 squash로 병합한다.
4. 병합된 `main`의 커밋에 annotated 태그를 만들어 푸시한다(`git tag -a vX.Y.Z -m "vX.Y.Z"`). `node src/release-notes.js notes <X.Y.Z>`의 출력을 GitHub Release 본문으로 쓴다. 배포 소스는 `main`이며 Release 첨부 파일은 쓰지 않는다.
5. 병합이 끝난 작업 브랜치를 로컬·원격에서 지운다.

## 공개 전 점검

- 전체 Git 이력과 추적 파일에서 `data/`, `.local/`, 대화 제목·내용, 개인 경로, 프로젝트 주소·ID, 인증정보가 없는지 확인한다. `repo:check`와 무시 대상 목록을 함께 점검한다.
- 새 클론에서 `npm install`, `npm test`, 앱 실행이 개인 데이터 없이 동작하는지 확인한다.
