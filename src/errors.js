// 내부 오류 문장(영문·검증 메시지)을 사용자가 바로 행동할 수 있는 "무슨 일 + 무엇을 하면 되는가"로 바꾼다.
// 순서가 중요하다: 더 구체적인 패턴이 앞에 온다.
// recovery: 화면이 오류 옆에 보여 줄 "다시 시작" 동작. rescan = 같은 범위를 다시 확인해 최신 상태를 읽는다.
const RULES = [
  { test: /Remote title does not match|Backup title does not match|Remote conversation ID does not match/i,
    title: "확인한 뒤 ChatGPT에서 대화 제목이 바뀌어 적용을 멈췄습니다",
    action: "이 실행의 결정은 예전 제목을 기준으로 해서 더 진행할 수 없습니다. 이미 적용된 부분은 그대로 유지됩니다. 같은 범위를 다시 확인하면 남은 대화가 새 후보로 나오니 그때 다시 검토하세요.",
    recovery: "rescan" },
  { test: /Uncertain in-progress receipt actions/i,
    title: "결과가 불확실한 작업이 남아 있습니다",
    action: "같은 작업을 자동으로 다시 하지 않고 멈췄습니다. ChatGPT에서 해당 대화의 현재 상태를 확인한 뒤 에이전트에게 오류 내용을 붙여넣어 알려 주세요." },
  { test: /\block\b|잠금/i,
    title: "다른 작업이 정리를 진행 중이거나 잠금이 남아 있습니다",
    action: "진행 중인 작업이 없다면 터미널에서 `node maintenance-lock.js release`로 잠금을 푸세요(6시간이 지나면 자동으로 풀립니다)." },
  { test: /HTTP 40[13]|accessToken|session lookup|session has no access token/i,
    title: "ChatGPT 로그인이 만료되었거나 세션을 읽지 못했습니다",
    action: "chatgpt.com에 다시 로그인하고 북마클릿(ChatGPT → 유지관리)을 다시 실행하세요." },
  { test: /HTTP 429|rate.?limit|429/i,
    title: "ChatGPT가 요청을 제한했습니다(429)",
    action: "적용 중이면 자동으로 기다렸다가 이어집니다. 확인 중이면 몇 시간 뒤 같은 버튼으로 이어서 하세요." },
  { test: /timed out|시간 초과|HTTP 599|page-timeout/i,
    title: "ChatGPT 페이지가 응답하지 않았습니다",
    action: "chatgpt.com 탭을 앞으로 가져온 뒤 같은 버튼을 다시 누르세요. 끝난 부분은 다시 하지 않습니다." },
  { test: /Relay client was replaced|relay page disconnected/i,
    title: "ChatGPT 연결(정리 창)이 바뀌거나 끊겨 작업이 중단되었습니다",
    action: "북마클릿을 다시 실행했거나 정리 창을 닫으면 이렇게 됩니다. 정리 창은 하나만 열어 두세요(이전 창은 닫기). 화면이 ‘ChatGPT 연결됨’이면 같은 버튼으로 다시 시작하세요. 끝난 부분은 다시 하지 않습니다.",
    recovery: "rescan" },
  { test: /relay.*not connected|릴레이|ChatGPT relay page/i,
    title: "ChatGPT와 연결되어 있지 않습니다",
    action: "chatgpt.com 탭에서 북마클릿(ChatGPT → 유지관리)을 실행하세요." },
  { test: /HTTP 5\d\d/i,
    title: "ChatGPT 서버가 일시적으로 오류를 냈습니다",
    action: "잠시 뒤 같은 버튼으로 다시 시도하세요." },
  { test: /사용자가 중단/,
    title: "사용자가 작업을 중단했습니다",
    action: "끝난 부분은 유지됩니다. 같은 버튼으로 이어서 진행할 수 있습니다." },
  { test: /INTERRUPTED|서버가 종료/,
    title: "서버가 종료되어 작업이 중단되었습니다",
    action: "같은 버튼으로 이어서 진행할 수 있습니다." },
];

export function explainError(message) {
  const text = String(message || "");
  for (const rule of RULES) if (rule.test.test(text)) return { title: rule.title, action: rule.action, ...(rule.recovery ? { recovery: rule.recovery } : {}) };
  return { title: text.split("\n")[0].slice(0, 160) || "알 수 없는 오류",
    action: "‘오류 복사’로 내용을 복사해 에이전트에게 붙여넣어 알려 주세요." };
}
