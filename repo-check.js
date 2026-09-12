#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const forbiddenPaths = [
  /^(?:exports|classification|management-plans|management-receipts|project-routing)(?:\/|$)/,
  /^data(?:\/|$)/,
  /^maintenance\/runs(?:\/|$)/,
  /^(?:\.local|\.auth|\.chrome-profile)(?:\/|$)/,
  /(?:^|\/)(?:session|cookies?)(?:[-_.][^/]*)?\.json$/i,
  /(?:^|\/)\.env(?:\.|$)/,
  /\.(?:pem|key)$/i,
];

// Secret shapes that are personal regardless of who runs the check.
const staticSecretPatterns = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "OpenAI-style secret key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "serialized ChatGPT access token", pattern: /["']accessToken["']\s*:\s*["']eyJ[A-Za-z0-9_-]{20,}/ },
  { name: "serialized refresh token", pattern: /["']refreshToken["']\s*:\s*["'][A-Za-z0-9._-]{20,}/ },
];

// Usernames that stand for "anyone" — documentation examples and CI runners.
// When the current account name is one of these we skip the personal-path
// checks entirely so example paths and CI machines do not trip the check.
const PLACEHOLDER_ACCOUNT_NAMES = new Set([
  "user", "users", "you", "yourname", "your-name", "home", "me", "name",
  "example", "admin", "administrator", "test", "ci", "runner", "runneradmin",
  "vagrant", "ubuntu", "node", "root",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build patterns that flag the machine-specific home path of whoever runs the
// check. This replaces the previous hard-coded developer account name so any
// contributor's local run (and pre-commit hook) catches their own absolute
// paths without the repository naming a real person.
export function personalPathPatterns(home = homedir()) {
  const account = basename(home || "");
  if (!account || account.length < 2 || PLACEHOLDER_ACCOUNT_NAMES.has(account.toLowerCase())) {
    return [];
  }
  const patterns = [];
  if (home && home.length > 3) {
    const variants = new Set([home, home.replaceAll("/", "\\"), home.replaceAll("\\", "/")]);
    for (const variant of variants) {
      patterns.push({
        name: "personal home path",
        pattern: new RegExp(`${escapeRegExp(variant)}(?:[/\\\\]|$)`),
      });
    }
  }
  const account_ = escapeRegExp(account);
  patterns.push({ name: "personal macOS home path", pattern: new RegExp(`/Users/${account_}(?:/|\\\\|$)`, "i") });
  patterns.push({ name: "personal Windows home path", pattern: new RegExp(`[A-Za-z]:\\\\Users\\\\${account_}(?:\\\\|/|$)`, "i") });
  patterns.push({ name: "personal Linux home path", pattern: new RegExp(`/home/${account_}(?:/|\\\\|$)`, "i") });
  return patterns;
}

export function findRepoIssues(files, {
  readFile = (file) => readFileSync(file, "utf8"),
  statFile = (file) => statSync(file),
  secretPatterns = [...staticSecretPatterns, ...personalPathPatterns()],
} = {}) {
  const errors = [];
  const caseInsensitivePaths = new Map();

  for (const file of files) {
    const normalized = file.replaceAll("\\", "/");
    const folded = normalized.toLowerCase();
    if (caseInsensitivePaths.has(folded) && caseInsensitivePaths.get(folded) !== normalized) {
      errors.push(`${file}: conflicts by case with ${caseInsensitivePaths.get(folded)} on Windows/macOS`);
    } else {
      caseInsensitivePaths.set(folded, normalized);
    }
    for (const segment of normalized.split("/")) {
      const stem = segment.split(".")[0].toUpperCase();
      if (/[<>:"|?*]/.test(segment) || /[. ]$/.test(segment)
        || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
        errors.push(`${file}: path is not portable to Windows`);
        break;
      }
    }
    if (forbiddenPaths.some((pattern) => pattern.test(normalized))) {
      errors.push(`${file}: forbidden local or sensitive path`);
      continue;
    }
    let stat;
    try { stat = statFile(file); } catch { continue; }
    if (!stat.isFile()) continue;
    if (stat.size > 10 * 1024 * 1024) {
      errors.push(`${file}: file is larger than 10 MiB`);
      continue;
    }
    if (/\.(?:png|jpe?g|gif|webp|pdf|zip)$/i.test(file)) continue;
    let text;
    try { text = readFile(file); } catch { continue; }
    for (const { name, pattern } of secretPatterns) {
      if (pattern.test(text)) errors.push(`${file}: possible ${name}`);
    }
  }
  return errors;
}

function main() {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(result.stderr.trim() || "Could not enumerate repository files");
    process.exit(1);
  }

  const files = result.stdout.split("\0").filter(Boolean);
  const errors = findRepoIssues(files);

  if (errors.length) {
    console.error(["Repository safety check failed:", ...errors.map((item) => `- ${item}`)].join("\n"));
    process.exit(1);
  }

  console.log(`Repository safety check passed (${files.length} included files).`);
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) main();
