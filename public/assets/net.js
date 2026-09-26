// 서버 호출, 오류 알림.
import { $, fill, h } from "/assets/dom.js";

export async function api(url, options) {
  const response = await fetch(url, { cache: "no-store", ...options, headers: { "Content-Type": "application/json", ...(options?.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error?.message || `HTTP ${response.status}`), { detail: data.error });
  return data;
}

export const post = (path, body = {}) => api(path, { method: "POST", body: JSON.stringify(body) });

export function toast(message, detail = "") {
  const box = $("toast");
  fill(box, h("strong", { text: message }), detail ? h("pre", { text: detail }) : null,
    h("div", { class: "row" }, h("button", { class: "btn ghost", type: "button", onclick: () => { box.hidden = true; } }, "닫기"),
      h("button", { class: "btn ghost", type: "button", onclick: (e) => { navigator.clipboard.writeText([message, detail && detail !== message ? detail : ""].filter(Boolean).join("\n")); e.target.textContent = "복사됨"; } }, "오류 복사")));
  box.hidden = false;
}

function friendly(error) {
  const explain = error?.detail?.explain;
  if (explain) return [explain.title, `${explain.action}\n\n${error.detail.message || ""}`.trim()];
  const message = String(error?.message || error);
  if (/failed to fetch|networkerror|load failed/i.test(message)) return ["앱 서버에 연결하지 못했습니다.", "터미널에서 `npm run app`으로 앱을 켠 뒤 새로고침하세요."];
  return [message, ""];
}

export const fail = (error) => { const [m, d] = friendly(error); toast(m, d); };
