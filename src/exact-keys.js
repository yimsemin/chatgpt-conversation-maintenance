import { assert } from "./assert.js";

export function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(JSON.stringify(actual) === JSON.stringify(wanted),
    `${label} must contain only: ${wanted.join(", ")}`);
}
