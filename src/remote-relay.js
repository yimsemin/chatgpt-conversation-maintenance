import { createRelayBroker } from "./relay-api.js";
import { relayTrace } from "./relay-trace.js";
import { APP_VERSION, RELAY_VERSION } from "./app-version.js";

export const relayBroker = createRelayBroker({ trace: relayTrace });

// 유지관리 창만 관측할 수 있는 경계(창→페이지 postMessage, 페이지 ack, 결과 수신,
// 하트비트 버전 불일치, 루프 오류)를 같은 추적 버퍼에 합친다.
const CLIENT_STAGES = new Set([
  "post-to-page", "page-ack", "page-result", "page-timeout",
  "peer-ignored", "version-mismatch", "loop-error",
]);

export function validateRelayVersion(relayVersion) {
  if (relayVersion !== RELAY_VERSION) {
    throw new Error(`Relay version mismatch: app=${RELAY_VERSION}`);
  }
}

export async function handleRemoteRelayRequest(req, res, { readJson, jsonResponse }) {
  const url = new URL(req.url, "http://127.0.0.1");
  if (!url.pathname.startsWith("/relay/")) return false;
  try {
    if (req.method === "GET" && url.pathname === "/relay/trace") {
      jsonResponse(res, 200, { version: APP_VERSION, relayVersion: RELAY_VERSION, events: relayTrace.list() });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/relay/trace") {
      const body = await readJson(req);
      if (!CLIENT_STAGES.has(body?.stage)) {
        jsonResponse(res, 400, { error: { message: "Unsupported trace stage" } });
        return true;
      }
      relayTrace.record(body.stage, {
        op: body.op, requestId: body.requestId, clientId: body.clientId,
        status: body.status, elapsedMs: body.elapsedMs, note: body.note,
      });
      jsonResponse(res, 200, { recorded: true });
      return true;
    }
    if (req.method === "GET" && url.pathname === "/relay/status") {
      jsonResponse(res, 200, { ...relayBroker.status(), version: APP_VERSION,
        relayVersion: RELAY_VERSION });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/relay/connect") {
      const body = await readJson(req);
      validateRelayVersion(body.relayVersion);
      jsonResponse(res, 200, relayBroker.connect(body.clientId));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/relay/next") {
      const body = await readJson(req);
      jsonResponse(res, 200, relayBroker.next(body.clientId));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/relay/result") {
      const body = await readJson(req);
      jsonResponse(res, 200, relayBroker.complete(body.clientId, body.requestId, body.result));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/relay/disconnect") {
      const body = await readJson(req);
      jsonResponse(res, 200, relayBroker.disconnect(body.clientId));
      return true;
    }
    jsonResponse(res, 404, { error: { message: "Unsupported relay request" } });
  } catch (error) {
    jsonResponse(res, 400, { error: { message: String(error?.message || error) } });
  }
  return true;
}
