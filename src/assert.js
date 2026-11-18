import { localizedError } from "./i18n.js";

export function assert(condition, message) {
  if (!condition) throw message?.key ? localizedError(message) : new Error(message);
}
