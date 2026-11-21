// 서버 호출, 오류 알림.
import { errorExplanation, locale, t } from "/assets/language.js";
import { $, fill, h } from "/assets/dom.js";

export async function api(url, options) {
  const response = await fetch(url, { cache: "no-store", ...options, headers: { "Content-Type": "application/json", "X-Maintenance-Language": locale, ...(options?.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error?.message || `HTTP ${response.status}`), { detail: data.error });
  return data;
}

export const post = (path, body = {}) => api(path, { method: "POST", body: JSON.stringify(body) });

export function toast(message, detail = "") {
  const box = $("toast");
  fill(box, h("strong", { text: message }), detail ? h("pre", { text: detail }) : null,
    h("div", { class: "row" }, h("button", { class: "btn ghost", type: "button", onclick: () => { box.hidden = true; } }, t("net.close")),
      h("button", { class: "btn ghost", type: "button", onclick: (e) => { navigator.clipboard.writeText([message, detail && detail !== message ? detail : ""].filter(Boolean).join("\n")); e.target.textContent = t("net.copied"); } }, t("net.copy.error"))));
  box.hidden = false;
}

function friendly(error) {
  const explain = errorExplanation(error?.detail);
  if (explain) return [explain.title, `${explain.action}\n\n${error.detail.message || ""}`.trim()];
  const message = String(error?.message || error);
  if (/failed to fetch|networkerror|load failed/i.test(message)) return [t("net.serverUnreachable"), t("net.runNpmApp")];
  return [message, ""];
}

export const fail = (error) => { const [m, d] = friendly(error); toast(m, d); };
