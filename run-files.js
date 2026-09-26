// 한 실행 폴더(runs/<id>/) 안의 파일 이름의 단일 정의. 문자열 경로를 여기저기서 조립하지 않는다.
import { join } from "node:path";

export function runFiles(runDir) {
  return {
    dir: runDir,
    jsonDir: join(runDir, "json"),
    inventory: join(runDir, "inventory.json"),
    catalog: join(runDir, "catalog.json"),
    review: join(runDir, "review.json"),
    prompt: join(runDir, "classification-prompt.md"),
    proposal: join(runDir, "proposal.json"),
    decisions: join(runDir, "reviewed-decisions.json"),
    plans: join(runDir, "plans"),
    routing: join(runDir, "routing.json"),
    receipts: join(runDir, "receipts"),
    planSource: join(runDir, "compiled-plan-source.json"),
    report: join(runDir, "report.json"),
    reportMarkdown: join(runDir, "report.md"),
    trashMeta: join(runDir, "trash-meta.json"),
    followUp: join(runDir, "followup.json"),
    afterCatalog: join(runDir, "after-catalog.json"),
  };
}
