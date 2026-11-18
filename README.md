# ChatGPT 대화 정리

**English summary.** Organize your ChatGPT conversations with help from an AI agent. Standardize titles, group related chats into projects, and set aside candidates for deletion. Review and approve changes in a local web dashboard.

**Disclaimer.** This unofficial tool uses ChatGPT’s undocumented web API. It is provided “as is,” without warranty. Use it at your own risk. [MIT License](LICENSE)

## 소개

AI의 도움을 받아 쌓여 있는 ChatGPT 대화의 제목을 정리하고, 관련 대화를 프로젝트로 묶고, 다시 참고할 일이 적은 대화를 골라낼 수 있습니다. 에이전트가 정리안을 만들면 사용자가 웹 대시보드에서 검토하고 적용합니다.

## 기능

- **제목 변경** — 대화 제목을 `핵심 주제 — 실제 작업 또는 결과` 형식으로 맞춥니다.
- **프로젝트 배치** — 주제에 맞는 프로젝트로 대화를 옮깁니다. 적합한 기존 프로젝트가 없고 계속 쓸 주제라면 새 프로젝트를 제안합니다.
- **삭제후보 골라내기** — 재사용 가치가 낮은 대화는 기본적으로 삭제후보 프로젝트에 모읍니다. 나중에 사용자가 **삭제후보 확인**에서 삭제하거나 복원합니다.
- **웹 대시보드** — 처음 쓰는 사람도 화면 안내를 따라 수집 범위를 고르고, 제안을 검토하고, 적용 결과를 확인할 수 있습니다.

## 빠른 시작

macOS 또는 Windows에서 Node.js 24 이상과 ChatGPT에 로그인할 브라우저가 필요합니다.

### 에이전트에게 설치 요청하기

저장소의 **Code → Download ZIP**으로 받아 압축을 풀거나 Git으로 내려받습니다. 프로젝트 폴더를 Claude Code 또는 Codex에서 열고 아래 요청문을 보냅니다.

> 이 프로젝트를 기본 설정으로 쓸 수 있게 준비해줘. AGENTS.md를 읽고 Node.js 버전과 설치 상태를 확인한 뒤, 점검을 마치면 내가 직접 할 일만 알려줘.

### 첫 정리하기

에이전트에게 현재 단계부터 안내받으려면 아래 요청문을 보냅니다.

> 이 프로젝트에서 처음으로 ChatGPT 대화를 정리하려고 해. 앱 실행과 ChatGPT 연결부터 수집, 분류 요청, 검토와 적용까지 내가 직접 할 일을 순서대로 알려줘.

직접 따라 하려면 다음 순서로 진행합니다.

1. 프로젝트 폴더에서 Windows는 `start-local.cmd`, macOS는 `start-local.command`를 엽니다. 터미널에서는 `npm run app`으로 켜고 `Ctrl+C`로 끕니다. 정리가 끝날 때까지 실행 창을 열어 둡니다.
2. 브라우저에서 ChatGPT에 로그인합니다. 처음 연결할 때는 앱의 연결 안내 화면에서 **ChatGPT → 유지관리** 버튼을 북마크바로 끌어다 놓습니다. [연결 안내 화면](http://127.0.0.1:8523/auth/bookmarklet)
3. 로그인한 ChatGPT 탭에서 방금 등록한 북마크를 누릅니다. 새 **대화 정리** 창에 **ChatGPT 연결됨**이 표시되면 준비가 끝난 것입니다.
4. 대시보드에서 범위를 골라 **이 범위 수집**을 누릅니다. 화면에 나온 요청문을 에이전트에게 보내고, 제안이 나오면 검토한 뒤 **적용 → 적용 시작**을 누릅니다. 완료 후 **직접 하실 일**을 확인합니다.

막히면 화면의 **오류 복사**로 내용을 에이전트에게 전달하세요. 연결이 끊겼다면 ChatGPT 탭에서 북마크를 다시 누릅니다. 중단된 수집은 같은 범위에서 이어받을 수 있습니다.

## 주의사항

- **비공식 API** — ChatGPT 웹 서비스가 바뀌면 연결이나 정리 기능이 작동하지 않을 수 있습니다.
- **첫 전체 수집** — 대화가 많으면 몇 시간 걸릴 수 있습니다. 처음에는 **프로젝트에 넣지 않은 대화 · 최근 14일**처럼 작은 범위로 시작할 수 있습니다. [수집 범위와 옵션](docs/ARCHITECTURE.md#수집-범위와-옵션)
- **작업 중 연결** — 수집과 적용이 끝날 때까지 ChatGPT 탭과 정리 창을 열어 두고 최소화하지 않습니다.
- **관리 범위** — 대화 보관·보관 해제와 ChatGPT Memory 설정은 ChatGPT에서 직접 관리합니다. **모든 대화** 범위에는 보관된 대화도 포함됩니다.
- **영구 삭제** — 삭제후보 프로젝트로 이동한 대화는 복원할 수 있지만, 영구 삭제를 확정한 대화는 되돌릴 수 없습니다.
- **대화 사본** — 정리 과정에서 대화 사본이 기본적으로 프로젝트 폴더의 `data/`에 저장됩니다. 다른 AI 서비스에 분류 입력을 붙여넣으면 대화 발췌본이 해당 서비스로 전달됩니다. [데이터와 로컬 설정](docs/ARCHITECTURE.md#데이터와-코드의-분리)

업데이트는 에이전트에게 맡기거나 앱을 끈 뒤 Git으로 내려받은 폴더에서 `git pull --ff-only`를 실행합니다. ZIP을 썼다면 새 ZIP의 파일을 같은 폴더에 풉니다. `data/`와 `.local/`은 보관하고, 업데이트 후 앱을 다시 켭니다.

## 라이선스

[MIT License](LICENSE)
