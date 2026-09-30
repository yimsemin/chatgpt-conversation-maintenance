import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyPrune, planPrune } from "../src/runs-prune.js";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";
const ID4 = "44444444-4444-4444-8444-444444444444";

test("pruning keeps one newest body per conversation and never touches protected copies", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "chatgpt-maintenance-prune-"));
  try {
    const run = (name, { inventory = true, bodies }) => {
      const dir = join(dataDir, "runs", name);
      mkdirSync(join(dir, "json"), { recursive: true });
      if (inventory) writeFileSync(join(dir, "inventory.json"), "{}");
      writeFileSync(join(dir, "report.json"), "{}");
      for (const [id, time] of Object.entries(bodies)) writeFileSync(join(dir, "json", `${id}.json`), JSON.stringify({ update_time: time, mapping: {} }));
      return dir;
    };
    const a = run("a-old", { bodies: { [ID1]: 100, [ID2]: 100, [ID3]: 100 } });
    const b = run("b-new", { bodies: { [ID1]: 200, [ID3]: 100 } });
    const current = run("c-current", { bodies: { [ID2]: 100 } });
    const draft = run("d-draft", { inventory: false, bodies: { [ID4]: 50 } });
    run("e-later", { bodies: { [ID4]: 60 } });
    // 삭제후보 목록이 A 의 ID3 본문을 가리킨다.
    writeFileSync(join(dataDir, "trash.json"), JSON.stringify({ version: 1, project: "삭제후보", items: [{ conversationId: ID3, backupFile: join(a, "json", `${ID3}.json`) }] }));

    const plan = planPrune({ dataDir, currentRunDir: current });
    const removed = plan.remove.map((item) => `${item.run}/${item.id}`).sort();
    assert.deepEqual(removed, [`a-old/${ID1}`, `a-old/${ID2}`, `b-new/${ID3}`].sort(),
      "older ID1 and ID2 (a newer or protected copy exists) and the duplicate ID3 go; the trash-referenced ID3, the current run and the resumable draft stay");
    assert.ok(plan.freedBytes > 0 && plan.totalBytes > plan.freedBytes);
    assert.equal(existsSync(join(a, "json", `${ID1}.json`)), true, "planning deletes nothing");

    assert.equal(applyPrune(plan), 3);
    assert.equal(existsSync(join(a, "json", `${ID1}.json`)), false);
    assert.equal(existsSync(join(a, "json", `${ID3}.json`)), true);
    assert.equal(existsSync(join(b, "json", `${ID1}.json`)), true);
    assert.equal(existsSync(join(b, "json", `${ID3}.json`)), false);
    assert.equal(existsSync(join(draft, "json", `${ID4}.json`)), true);
    assert.equal(existsSync(join(a, "report.json")), true, "records other than bodies are never removed");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
