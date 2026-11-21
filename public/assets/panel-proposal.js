// 분류 제안을 받는 패널.
import { t } from "/assets/language.js";
import { S } from "/assets/state.js";
import { h } from "/assets/dom.js";
import { fail, post } from "/assets/net.js";
import { refreshSession } from "/assets/session-client.js";
import { skippedCallout } from "/assets/panel-scan.js";

// ---------- step 2: proposal ----------
export function proposalPanel() {
  const run = S.session.run;
  const prompt = t("proposal.agentPrompt");
  const paste = h("textarea", { rows: "6", "aria-label": t("proposal.pasteJson"), placeholder: t("proposal.pasteJson") });
  return h("div", {},
    h("p", { class: "muted", text: t("proposal.sendPrompt") }),
    run?.standardTitlesExcluded ? h("p", { class: "muted small", text: t("proposal.skippedStandardTitles", { count: run.standardTitlesExcluded }) }) : null,
    run?.skipped?.length ? skippedCallout(run.skipped) : null,
    h("div", { class: "callout", text: prompt }),
    h("div", { class: "row" }, h("button", { class: "btn", type: "button", onclick: async (e) => { await navigator.clipboard.writeText(prompt); e.target.textContent = t("proposal.copied"); } }, t("proposal.copy.prompt"))),
    h("details", {}, h("summary", { text: t("proposal.pasteManually") }),
      h("div", { class: "body" }, paste, h("div", { class: "row" }, h("button", { class: "btn ghost", type: "button", onclick: async () => {
        try { await post("/maintenance/proposal", { proposalJson: paste.value }); await refreshSession(); } catch (e) { fail(e); }
      } }, t("proposal.loadProposal"))))));
}
