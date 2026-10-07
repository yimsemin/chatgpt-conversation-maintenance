import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 임시 폴더를 만들어 fn(root)에 주고, 끝나면(실패해도) 지운다.
export async function withTemp(prefix, fn) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try { return await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
