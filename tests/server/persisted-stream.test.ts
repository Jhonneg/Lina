import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createChatStreamHandler } from "../../src/server/chat-stream-handler";
import { RequestError } from "../../src/server/chat-request";
import type { StreamClaim } from "../../src/server/stream-persistence";

const sessionId = randomUUID(), requestId = randomUUID();
const input = { mode: "persisted", requestId, messages: [{ role: "user", content: "Hello" }] };
const receipt: StreamClaim = { sessionId, requestId, conversationId: randomUUID(), userMessageId: randomUUID(),
  assistantMessageId: randomUUID(), isNew: true, state: "running", content: "" };
function request(body: unknown = input, signal?: AbortSignal, headers = {}) {
  return new Request("http://localhost/api/chat/stream", { method: "POST", signal,
    headers: { "Content-Type": "application/json", Origin: "http://localhost", ...headers }, body: JSON.stringify(body) });
}
function frames(text: string) {
  return text.split("\n\n").filter(Boolean).map(frame => { const [event, data] = frame.split("\n"); return { event: event.slice(7), data: JSON.parse(data.slice(6)) }; });
}
const sessionService = { async getExistingSession() { return { id: sessionId, expiresAt: new Date(Date.now() + 60000) }; } };

test("persisted metadata precedes deltas; done waits for a single final durable save", async () => {
  let release!: () => void, entered!: () => void;
  const saved = new Promise<void>(resolve => { release = resolve; });
  const saving = new Promise<void>(resolve => { entered = resolve; });
  const writes: unknown[] = [];
  const handler = createChatStreamHandler({ sessionService, getAdapter: () => ({ async *stream() { yield "Hello "; yield "world"; } }),
    getPersistence: () => ({ async begin(id, body) { assert.equal(id, sessionId); assert.equal(body.requestId, requestId); return receipt; },
      async finish(_receipt, text, status) { writes.push({ text, status }); entered(); await saved; } }) });
  const response = await handler(request()), reader = response.body!.getReader(), decoder = new TextDecoder();
  const metadata = frames(decoder.decode((await reader.read()).value))[0];
  assert.equal(metadata.event, "metadata");
  assert.deepEqual(metadata.data, { requestId, conversationId: receipt.conversationId, userMessageId: receipt.userMessageId,
    assistantMessageId: receipt.assistantMessageId, replayed: false });
  for (let n = 0; n < 2; n++) assert.equal(frames(decoder.decode((await reader.read()).value))[0].event, "delta");
  assert.equal(writes.length, 0);
  const terminal = reader.read(); await saving;
  assert.deepEqual(writes, [{ text: "Hello world", status: "completed" }]);
  release();
  assert.deepEqual(frames(decoder.decode((await terminal).value)), [{ event: "done", data: { finishReason: "completed", saved: true } }]);
  assert.equal((await reader.read()).done, true);
});

test("cancellation preserves accepted partial output as interrupted and aborts generation", async () => {
  const writes: unknown[] = [];
  let providerSignal: AbortSignal | undefined;
  const response = await createChatStreamHandler({ sessionService,
    getAdapter: () => ({ async *stream(_messages, signal) { providerSignal = signal; yield "partial"; await delay(10000, undefined, { signal }); } }),
    getPersistence: () => ({ async begin() { return receipt; }, async finish(_r, content, status) { writes.push({ content, status }); } }),
  })(request());
  const reader = response.body!.getReader(); await reader.read(); await reader.read();
  const pending = reader.read(); await reader.cancel(); await pending;
  assert.deepEqual(writes, [{ content: "partial", status: "interrupted" }]);
  assert.ok(providerSignal?.aborted);
});

test("generation failures save partial output as failed; database finalization failures never emit done", async () => {
  for (const storageFailure of [false, true]) {
    const writes: unknown[] = [];
    const response = await createChatStreamHandler({ sessionService,
      getAdapter: () => ({ async *stream() { yield "partial"; if (!storageFailure) throw new Error("DO_NOT_LEAK"); } }),
      getPersistence: () => ({ async begin() { return receipt; }, async finish(_r, content, status) {
        writes.push({ content, status }); if (storageFailure) throw new Error("DO_NOT_LEAK database");
      } }),
    })(request());
    const events = frames(await response.text());
    assert.deepEqual(events.map(x => x.event), ["metadata", "delta", "error"]);
    assert.equal(events[2].data.code, storageFailure ? "PERSISTENCE_UNAVAILABLE" : "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(events).includes("DO_NOT_LEAK"));
    assert.deepEqual(writes, [{ content: "partial", status: storageFailure ? "completed" : "failed" }]);
  }
});

test("persisted session, origin and request validation fail closed before any claim", async () => {
  let claims = 0;
  const handler = createChatStreamHandler({ sessionService, getPersistence: () => ({
    async begin() { claims++; return receipt; }, async finish() {},
  }) });
  for (const body of [
    { ...input, requestId: "invalid" }, { ...input, conversationId: "invalid" }, { ...input, conversationId: null },
    { ...input, messages: [{ role: "assistant", content: "reply" }] }, { ...input, sessionId },
    { ...input, mode: "unknown" }, { requestId, messages: input.messages },
  ]) assert.equal((await handler(request(body))).status, 400);
  assert.equal((await handler(request(input, undefined, { Origin: "" }))).status, 403);
  const unauthorized = createChatStreamHandler({ sessionService: { async getExistingSession() { return null; } } });
  assert.equal((await unauthorized(request())).status, 401);
  assert.equal(claims, 0);
});

test("claim failures are safe JSON errors; provider initialization failure finalizes a claimed request", async () => {
  const failure = await createChatStreamHandler({ sessionService, getPersistence: () => ({
    async begin() { throw new RequestError(503, "PERSISTENCE_UNAVAILABLE", "Storage unavailable."); }, async finish() {},
  }) })(request());
  assert.equal(failure.status, 503); assert.equal((await failure.json()).error.code, "PERSISTENCE_UNAVAILABLE");
  let status;
  const initialized = await createChatStreamHandler({ sessionService, getAdapter: () => { throw new Error("DO_NOT_LEAK"); },
    getPersistence: () => ({ async begin() { return receipt; }, async finish(_r, _c, state) { status = state; } }),
  })(request());
  assert.equal(initialized.status, 500); assert.equal(status, "failed");
});

test("legacy and explicit ephemeral modes remain database-free with the original SSE contract", async () => {
  const handler = createChatStreamHandler({
    getAdapter: () => ({ async *stream() { yield "reply"; } }),
    sessionService: { async getExistingSession() { throw new Error("Must not resolve sessions"); } },
    getPersistence: () => { throw new Error("Must not access persistence"); },
  });
  for (const body of [{ messages: input.messages }, { mode: "ephemeral", messages: input.messages }]) {
    assert.deepEqual(frames(await (await handler(request(body))).text()).map(x => x.event), ["delta", "done"]);
  }
});
