#!/usr/bin/env node
// 실계정 없이 화면·흐름 전체를 시험하는 개발용 서버. 모의 ChatGPT 계정을 만들고 릴레이 브로커에 붙인다.
// 실제 데이터 폴더를 건드리지 않고 임시 앱 폴더를 새로 만든다. 사용: node dev/fake-server.js [--slow] [--rate-limit]
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assembleProposal } from "../src/overhaul.js";
import { relayBroker } from "../src/remote-relay.js";
import { attachFakePage, createFakeChatGPT, fakeConversationId, fakeProjectId } from "../test/support/fake-chatgpt.js";

process.argv.push("--no-open");
const slow = process.argv.includes("--slow");
const rateLimited = process.argv.includes("--rate-limit");
const noRelay = process.argv.includes("--no-relay");
// 제안이 만들어진 직후 후보 하나의 제목을 ChatGPT 쪽에서 바꿔, 적용이 "제목 불일치"로 멈추는 상황을 만든다.
const renameAfterProposal = process.argv.includes("--rename-after-proposal");

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

// 프로젝트에 넣지 않은 새 대화(제목 형식 위반, 잡음, 정상). 프로젝트 없는 대화 범위의 후보가 된다.
const news = [
  ["새 대화 하나", null], ["테스트 입력", null], ["이어폰 후기 — 신제품 청음", null],
  ["회의록 정리", null], ["프롬프트 검증 — 재현 실험", null], ["임시 메모", null],
];
news.forEach(([title], i) => fake.addConversation({ id: fakeConversationId(100 + i), title }));

// 이 서버는 실제 저장소 폴더가 아니라 방금 만든 임시 폴더를 앱 폴더로 쓴다.
process.env.MAINTENANCE_ROOT = root;
// --drop-relay-after=N: N번째 요청에서 정리 창이 바뀐 것처럼 끊고 새 창을 붙인다(중단 복구 시험).
const dropArg = process.argv.find((item) => item.startsWith("--drop-relay-after="));
if (dropArg && !noRelay) {
  let left = Number(dropArg.split("=")[1]);
  const realHandle = fake.handle.bind(fake);
  let page = null;
  fake.handle = async (request) => {
    if (left-- === 0) {
      const old = page;
      setTimeout(() => { relayBroker.disconnect(old.clientId); page = attachFakePage(relayBroker, fake); }, 0);
      return undefined;
    }
    return realHandle(request);
  };
  page = attachFakePage(relayBroker, fake);
} else if (!noRelay) attachFakePage(relayBroker, fake);

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
      return junk ? { id: item.conversationId, decision: "delete", title, confidence: "high", why: "테스트·임시 대화" }
        : { id: item.conversationId, decision: i % 5 === 0 ? "undecided" : "keep", title, project: PROJECTS[i % PROJECTS.length],
          confidence: i % 5 === 0 ? "low" : "medium", why: "모의 분류", projectWhy: "모의 배치" };
    }).map((v) => (v.decision === "undecided" ? { ...v, decision: "keep", confidence: "medium" } : v));
    writeFileSync(join(verdictsDir, "v.json"), JSON.stringify(verdicts));
    assembleProposal(pointer.inventoryPath, verdictsDir, pointer.proposalPath);
    console.log("[dev] 모의 에이전트가 proposal.json 을 만들었습니다");
    if (renameAfterProposal) {
      const target = verdicts.find((v) => v.title);
      if (target) {
        const conv = fake.conversations.get(target.id);
        conv.title = `${conv.title} (밖에서 바꿈)`;
        conv.update_time += 5;
      }
    }
  } catch (error) { if (!/already exists/.test(String(error.message))) console.log("[dev]", error.message); }
}, 1500);

const { startServer } = await import("../src/server.js");
startServer();
console.log(`[dev] 모의 ChatGPT 서버: 임시 앱 폴더 ${root}`);
