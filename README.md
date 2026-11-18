# ChatGPT 대화 정리

**English summary.** Organize your ChatGPT conversations with help from an AI agent. Standardize titles, group related chats into projects, and set aside candidates for deletion. Review and approve changes in a local web dashboard.

**Disclaimer.** This unofficial tool uses ChatGPT’s undocumented web API. It is provided “as is,” without warranty. Use it at your own risk.

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

Codex나 Claude Code에 아래 요청문을 보냅니다. 저장소를 내려받고 실행에 필요한 준비를 하는 일은 에이전트에게 맡깁니다.

**한국어**

> https://github.com/yimsemin/chatgpt-conversation-maintenance 저장소를 내 컴퓨터에 내려받고 실행할 수 있게 준비해줘. AGENTS.md를 읽고 Node.js 버전과 설치 상태를 확인해. 준비가 끝나면 프로젝트 폴더 위치와 내가 직접 할 다음 단계만 한국어로 알려줘.

**English**

> Download https://github.com/yimsemin/chatgpt-conversation-maintenance to my computer and get it ready to run. Read AGENTS.md and check my Node.js version and installation. When setup is complete, tell me in English where the project folder is and what I need to do next.

### 첫 정리하기

설치한 프로젝트 폴더를 에이전트에서 열고 아래 요청문을 보냅니다. 막히면 앱의 **오류 복사**로 내용을 에이전트에게 전달합니다.

**한국어**

> 이 프로젝트에서 처음으로 ChatGPT 대화를 정리하려고 해. 앱 실행과 ChatGPT 연결부터 수집, 분류 요청, 검토와 적용까지 내가 직접 할 일을 순서대로 알려줘.

**English**

> Walk me through my first ChatGPT cleanup in English. Show me how to start the app, choose English, connect to ChatGPT, collect conversations, request a cleanup proposal, and review and apply the changes. Tell me which steps I need to do myself.

## 주의사항

- **비공식 API** — ChatGPT 웹 서비스가 바뀌면 연결이나 정리 기능이 작동하지 않을 수 있습니다.
- **첫 전체 수집** — 대화가 많으면 몇 시간 걸릴 수 있습니다. 처음에는 **프로젝트에 넣지 않은 대화 · 최근 14일**처럼 작은 범위로 시작할 수 있습니다. [수집 범위와 옵션](docs/ARCHITECTURE.md#수집-범위와-옵션)
- **작업 중 연결** — 수집과 적용이 끝날 때까지 ChatGPT 탭과 정리 창을 열어 두고 최소화하지 않습니다.
- **관리 범위** — 대화 보관·보관 해제와 ChatGPT Memory 설정은 ChatGPT에서 직접 관리합니다. **모든 대화** 범위에는 보관된 대화도 포함됩니다.
- **영구 삭제** — 삭제후보 프로젝트로 이동한 대화는 복원할 수 있지만, 영구 삭제를 확정한 대화는 되돌릴 수 없습니다.
- **대화 사본** — 정리 과정에서 대화 사본이 기본적으로 프로젝트 폴더의 `data/`에 저장됩니다. 다른 AI 서비스에 분류 입력을 붙여넣으면 대화 발췌본이 해당 서비스로 전달됩니다. [데이터와 로컬 설정](docs/ARCHITECTURE.md#데이터와-코드의-분리)

## 라이선스

[MIT License](LICENSE)
