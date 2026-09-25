#!/usr/bin/env node
// 실계정 없이 화면·흐름 전체를 시험하는 개발용 서버. 모의 ChatGPT 계정을 만들고 릴레이 브로커에 붙인다.
// 실제 데이터 폴더를 건드리지 않고 임시 작업 폴더를 새로 만든다. 사용: node dev/fake-server.js [--slow] [--rate-limit]
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectConversationCatalog } from "../maintenance-cli.js";
import { assembleProposal } from "../overhaul.js";
import { createRelayApi } from "../relay-api.js";
import { relayBroker } from "../remote-relay.js";
import { attachFakePage, createFakeChatGPT, fakeConversationId, fakeProjectId } from "../test/support/fake-chatgpt.js";

process.argv.push("--no-open");
const slow = process.argv.includes("--slow");
const rateLimited = process.argv.includes("--rate-limit");

const root = mkdtempSync(join(tmpdir(), "chatgpt-maintenance-dev-"));
mkdirSync(join(root, ".local"), { recursive: true });
writeFileSync(join(root, "package.json"), JSON.stringify({ name: "chatgpt-conversation-maintenance", type: "module" }));
writeFileSync(join(root, ".local", "config.json"), JSON.stringify({ dataDir: join(root, "data") }));
mkdirSync(join(root, "data", "runs"), { recursive: true });

const PROJECTS = ["2609 혁신제품 도전", "오디오", "AI 개발도구", "개인 IT", "주식"];
const projects = PROJECTS.map((name, i) => ({ id: fakeProjectId(i + 1), name }));
const TITLES = ["이어폰 리뷰 — 구매 검토", "프롬프트 지침 — 간결화", "제안서 문안 — 사업화 계획", "맥 설정 — 키 반복", "종목 검토 — 메모"];
const conversations = [];
for (let i = 1; i <= 60; i++) {
  conversations.push({ id: fakeConversationId(i), title: `${TITLES[i % 5]} ${i}`, gizmo_id: i % 7 === 0 ? null : projects[i % 5].id });
}
const fake = createFakeChatGPT({ projects, conversations });
if (slow) fake.setLatency(400);
if (rateLimited) fake.inject({ op: "getConversation", status: 429, times: 4 });
// --inject=op:status:times (여러 번 지정 가능). 예: --inject=patchConversation:429:2
for (const arg of process.argv.filter((item) => item.startsWith("--inject="))) {
  const [op, status, times] = arg.slice("--inject=".length).split(":");
  fake.inject({ op, status: Number(status), times: Number(times) });
}

// 기준선: 지금 상태를 수집해 state.json 으로 저장한다.
const directApi = createRelayApi({ broker: { request: async ({ op, params }) => fake.handle({ op, params }) }, requestDelayMs: 0 });
const base = await collectConversationCatalog(directApi);
writeFileSync(join(root, "data", "state.json"), JSON.stringify({
  version: 1, kind: "conversation-maintenance-state", generatedAt: base.generatedAt, scope: base.scope,
  counts: base.counts, projects: base.projects, conversations: base.conversations,
}, null, 2));

// 기준선 이후 새로 생긴 대화(제목 형식 위반, 잡음, 정상)
const news = [
  ["새 대화 하나", null], ["테스트 입력", null], ["이어폰 후기 — 신제품 청음", null],
  ["회의록 정리", null], ["프롬프트 검증 — 재현 실험", null], ["임시 메모", null],
];
news.forEach(([title], i) => fake.addConversation({ id: fakeConversationId(100 + i), title }));

process.chdir(root);
attachFakePage(relayBroker, fake);

// 에이전트 역할: 분류 요청 상태가 되면 규칙으로 제안 파일을 만든다.
setInterval(() => {
  try {
    const pointerPath = join(root, ".local", "maintenance-web.json");
    if (!existsSync(pointerPath)) return;
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
    if (pointer.phase !== "awaiting-proposal" || existsSync(pointer.proposalPath)) return;
    const inventory = JSON.parse(readFileSync(pointer.inventoryPath, "utf8"));
    const verdictsDir = join(pointer.runDir, "verdicts");
    mkdirSync(verdictsDir, { recursive: true });
    const verdicts = inventory.conversations.map((item, i) => {
      const junk = /테스트|임시/.test(item.title);
      const title = item.title.includes(" — ") ? null : `${item.title.replace(/[—]/g, "").trim()} — 정리한 결과`;
      return junk ? { id: item.conversationId, decision: "delete", confidence: "high", why: "테스트·임시 대화" }
        : { id: item.conversationId, decision: i % 5 === 0 ? "undecided" : "keep", title, project: PROJECTS[i % PROJECTS.length],
          confidence: i % 5 === 0 ? "low" : "medium", why: "모의 분류", projectWhy: "모의 배치" };
    }).map((v) => (v.decision === "undecided" ? { ...v, decision: "keep", confidence: "medium" } : v));
    writeFileSync(join(verdictsDir, "v.json"), JSON.stringify(verdicts));
    assembleProposal(pointer.inventoryPath, verdictsDir, pointer.proposalPath);
    console.log("[dev] 모의 에이전트가 proposal.json 을 만들었습니다");
  } catch (error) { if (!/already exists/.test(String(error.message))) console.log("[dev]", error.message); }
}, 1500);

const { startServer } = await import("../server.js");
startServer();
console.log(`[dev] 모의 ChatGPT 서버: 작업 폴더 ${process.cwd()}`);
