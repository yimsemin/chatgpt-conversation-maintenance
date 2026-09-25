// 내부 오류 문장(영문·검증 메시지)을 사용자가 바로 행동할 수 있는 "무슨 일 + 무엇을 하면 되는가"로 바꾼다.
// 순서가 중요하다: 더 구체적인 패턴이 앞에 온다.
const RULES = [
  { test: /New conversation appeared during maintenance|빠른 검증 가정 위반/i,
    title: "적용하는 동안 다른 대화가 바뀐 것이 발견되었습니다",
    action: "‘빠른 검증’은 그동안 아무것도 바뀌지 않았다고 가정합니다. 고급에서 빠른 검증을 끄고 다시 적용하면 전체 재수집으로 검증합니다." },
  { test: /Uncertain in-progress receipt actions/i,
    title: "결과가 불확실한 작업이 남아 있습니다",
    action: "같은 작업을 자동으로 다시 하지 않고 멈췄습니다. ChatGPT에서 해당 대화의 현재 상태를 확인한 뒤 에이전트에게 오류 내용을 붙여넣어 알려 주세요." },
  { test: /Maintenance state changed after this scan/i,
    title: "스캔 이후 기준선이 바뀌었습니다",
    action: "‘새 대화 확인’을 다시 실행한 뒤 결정하세요." },
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
  for (const rule of RULES) if (rule.test.test(text)) return { title: rule.title, action: rule.action };
  return { title: text.split("\n")[0].slice(0, 160) || "알 수 없는 오류",
    action: "‘오류 복사’로 내용을 복사해 에이전트에게 붙여넣어 알려 주세요." };
}
