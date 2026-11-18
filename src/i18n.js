import { messages as ko } from "./messages-ko.js";
import { messages as en } from "./messages-en.js";

const registry = {
  ko: { label: "한국어", messages: ko },
  en: { label: "English", messages: en },
};
const placeholder = /\{([a-zA-Z][\w]*)\}/g;
export const fallbackLocale = "ko";
export const locales = Object.freeze(Object.fromEntries(Object.entries(registry).map(([locale, { label }]) => [locale, label])));

export function supportedLocale(value) {
  let language = String(value ?? "").trim().toLowerCase();
  while (language) {
    if (Object.hasOwn(registry, language)) return language;
    language = language.includes("-") ? language.slice(0, language.lastIndexOf("-")) : "";
  }
  return null;
}

export function translate(locale, key, values = {}) {
  const catalog = registry[supportedLocale(locale) ?? fallbackLocale].messages;
  const template = Object.hasOwn(catalog, key) ? catalog[key] : ko[key];
  return typeof template === "string" ? template.replace(placeholder, (match, parameter) =>
    Object.hasOwn(values, parameter) ? String(values[parameter] ?? "") : match) : key;
}

export function translator(locale) {
  return (key, values) => translate(locale, key, values);
}

export function messageText(locale, value, fallback = "") {
  if (!value || typeof value !== "object") return value || fallback;
  const values = Object.fromEntries(Object.entries(value.values ?? {}).map(([key, parameter]) =>
    [key, parameter && typeof parameter === "object" ? messageText(locale, parameter) : parameter]));
  return translate(locale, value.key, values);
}

export function message(key, values) {
  return values ? { key, values } : { key };
}

export function localizedError(diagnostic) {
  return Object.assign(new Error(messageText(fallbackLocale, diagnostic)), { diagnostic });
}

export function catalogIssues() {
  const parameters = (text) => [...new Set([...text.matchAll(placeholder)].map((match) => match[1]))].sort().join(",");
  const issues = [];
  for (const [locale, { messages: catalog }] of Object.entries(registry)) {
    if (locale === fallbackLocale) continue;
    for (const key of new Set([...Object.keys(ko), ...Object.keys(catalog)])) {
      if (!Object.hasOwn(catalog, key) || !Object.hasOwn(ko, key)) issues.push(`${locale}: missing or extra message ${key}`);
      else if (parameters(catalog[key]) !== parameters(ko[key])) issues.push(`${locale}: mismatched parameters for ${key}`);
    }
  }
  return issues;
}
