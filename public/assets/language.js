import { fallbackLocale, messageText, supportedLocale, translator } from "/assets/shared/i18n.js";

export const locale = document.documentElement.lang;
export const t = translator(locale);
export const displayMessage = (message) => messageText(locale, message);
export const progressLabel = (progress) => t(`log.phase.${progress.phase}`);
export function errorExplanation(error) {
  const explain = error?.explain;
  if (!explain) return null;
  return {
    ...explain,
    title: locale === fallbackLocale && explain.title ? explain.title : displayMessage(explain.titleContent) || explain.title,
    action: displayMessage(explain.actionContent) || explain.action || "",
  };
}
export const eventText = (event) => messageText(locale, event?.content, event?.message);

const select = document.getElementById("language");
if (select) select.addEventListener("change", () => {
  const next = supportedLocale(select.value);
  if (select.disabled || !next || next === locale) return;
  document.cookie = `maintenance_locale=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
  location.reload();
});
