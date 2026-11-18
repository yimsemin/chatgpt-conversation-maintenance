import { fallbackLocale, message, messageText } from "./i18n.js";

// 내부 오류 문장(영문·검증 메시지)을 사용자가 바로 행동할 수 있는 "무슨 일 + 무엇을 하면 되는가"로 바꾼다.
// 순서가 중요하다: 더 구체적인 패턴이 앞에 온다.
// recovery: 화면이 오류 옆에 보여 줄 "다시 시작" 동작. rescan = 같은 범위를 다시 수집해 최신 상태를 읽는다.
const RULES = [
  { test: /Remote title does not match|Backup title does not match|Remote conversation ID does not match/i,
    key: "staleTitle",
    recovery: "rescan" },
  { test: /Uncertain in-progress receipt actions/i,
    key: "uncertainWrite" },
  { test: /\block\b|잠금/i,
    key: "locked" },
  { test: /HTTP 40[13]|accessToken|session lookup|session has no access token/i,
    key: "auth" },
  { test: /HTTP 429|rate.?limit|429/i,
    key: "limited" },
  { test: /timed out|시간 초과|HTTP 599|page-timeout/i,
    key: "timeout" },
  { test: /Relay client was replaced|relay page disconnected/i,
    key: "relayChanged",
    recovery: "rescan" },
  { test: /relay.*not connected|릴레이|ChatGPT relay page/i,
    key: "relayDown" },
  { test: /HTTP 5\d\d/i,
    key: "remote" },
  { test: /사용자가 중단/,
    key: "cancelled" },
  { test: /INTERRUPTED|서버가 종료/,
    key: "interrupted" },
];

export function explainError(text, diagnostic) {
  const rule = diagnostic
    ? RULES.find(({ key }) => diagnostic.key === `error.${key}.title`)
    : RULES.find(({ test }) => test.test(String(text || "")));
  const titleContent = diagnostic || message(rule ? `error.${rule.key}.title` : "error.generic.title");
  const actionContent = message(rule ? `error.${rule.key}.action` : "error.generic.action");
  return {
    title: rule || diagnostic ? messageText(fallbackLocale, titleContent) : String(text || "").split("\n")[0].slice(0, 160) || messageText(fallbackLocale, titleContent),
    action: messageText(fallbackLocale, actionContent),
    titleContent, actionContent,
    ...(rule?.recovery ? { recovery: rule.recovery } : {}),
  };
}
