import { fallbackLocale, supportedLocale } from "./i18n.js";

export function requestLocale(headers) {
  const requested = supportedLocale(headers["x-maintenance-language"]);
  if (requested) return requested;
  const saved = headers.cookie?.match(/(?:^|;\s*)maintenance_locale=([a-zA-Z0-9-]+)(?:;|$)/)?.[1];
  const selected = supportedLocale(saved);
  if (selected) return selected;
  const accepted = (headers["accept-language"] || "").split(",").map((entry) => {
    const [language, quality] = entry.trim().split(/;\s*q=/i);
    return { locale: supportedLocale(language), quality: quality === undefined ? 1 : Number(quality) };
  });
  return accepted.filter(({ locale, quality }) => locale && quality > 0).sort((a, b) => b.quality - a.quality)[0]?.locale ?? (headers["accept-language"] ? "en" : fallbackLocale);
}
