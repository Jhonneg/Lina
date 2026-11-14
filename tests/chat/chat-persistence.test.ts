import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createSessionInitializer, restoreConversation, readPending, writePending, pendingMessages, reconcileMessages,
  savedSubmission, PENDING_KEY, type Submission } from "../../src/components/chat/chat-persistence";
import { chatReducer, INITIAL_CHAT } from "../../src/components/chat/chat-state";
import { streamChat, ChatStreamError, type StreamMetadata } from "../../src/components/chat/chat-stream";

const ownerId = randomUUID(), conversationId = randomUUID(), userId = randomUUID(), assistantId = randomUUID();
function intent(): Submission { return { ownerId, requestId: randomUUID(), userId: randomUUID(), startedAt: Date.now(), messages: [{ role: "user", content: "Hello" }], partial: "" }; }
function metadata(item: Submission, replayed = false): StreamMetadata { return { requestId: item.requestId, conversationId, userMessageId: userId, assistantMessageId: assistantId, replayed }; }
const wire = (name: string, data: object) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const sse = (text: string) => new Response(text, { headers: { "Content-Type": "text/event-stream" } });
const sessionJson = () => Response.json({ ok: true, session: { id: ownerId, expiresAt: new Date(Date.now() + 86400000).toISOString() }, token: "MUST_NOT_STORE" });
function store() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
function page(offset: number, messages: unknown[], nextOffset: number | null = null) {
  return Response.json({ ok: true, conversation: { id: conversationId }, messages,
    pagination: { limit: 50, offset, nextOffset } });
}
function row(id: string, content: string, status = "completed", role = "assistant") { return { id, conversationId, content, status, role }; }

test("session initialization is single-flight, cached across repeated calls, and uses browser credentials", async () => {
  let calls = 0;
  const init = createSessionInitializer(async (url, options) => {
    calls++; assert.equal(url, "/api/session"); assert.equal(options?.method, "POST");
    assert.equal(options?.credentials, "same-origin"); assert.equal(new Headers(options?.headers).get("Cookie"), null);
    return sessionJson();
  });
  const values = await Promise.all([init(), init(), init()]);
  assert.deepEqual(values, [ownerId, ownerId, ownerId]);
  assert.equal(await init(), ownerId); assert.equal(calls, 1);
  await init(true); assert.equal(calls, 2);
});

test("failed session initialization is recoverable and never caches failure", async () => {
  let calls = 0;
  const init = createSessionInitializer(async () => ++calls === 1 ? Response.json({ ok: false }, { status: 503 }) : sessionJson());
  await assert.rejects(init(), error => error instanceof ChatStreamError && error.code === "SESSION_INIT_FAILED");
  assert.equal(await init(), ownerId); assert.equal(calls, 2);
});

test("persisted SSE validates fragmented metadata and requires done(saved)", async () => {
  const item = intent(), meta = metadata(item), observed: unknown[] = [];
  const bytes = new TextEncoder().encode(wire("metadata", meta) + wire("delta", { text: "Olá 🌙" }) + wire("done", { finishReason: "completed", saved: true }));
  const fake: typeof fetch = async (_url, options) => {
    assert.equal(options?.credentials, "same-origin");
    assert.deepEqual(JSON.parse(String(options?.body)), { mode: "persisted", requestId: item.requestId, messages: item.messages });
    let index = 0;
    return new Response(new ReadableStream({ pull(controller) { if (index < bytes.length) controller.enqueue(bytes.slice(index, ++index)); else controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
  };
  await streamChat(item.messages, new AbortController().signal, text => observed.push(text), fake,
    { requestId: item.requestId, onMetadata: value => observed.push(value) });
  assert.deepEqual(observed, [meta, "Olá 🌙"]);
  for (const text of [wire("done", { finishReason: "completed", saved: true }), wire("metadata", meta) + wire("done", { finishReason: "completed" }),
    wire("metadata", { ...meta, requestId: randomUUID() }) + wire("done", { finishReason: "completed", saved: true })]) {
    await assert.rejects(streamChat(item.messages, new AbortController().signal, () => {}, async () => sse(text), { requestId: item.requestId, onMetadata() {} }));
  }
});

test("retry preserves original request UUID/payload and authoritative IDs without local duplicates", async () => {
  const item = intent(), original = JSON.stringify({ mode: "persisted", requestId: item.requestId, messages: item.messages });
  const user = { id: item.userId, role: "user" as const, content: "Hello" };
  let state = chatReducer(INITIAL_CHAT, { type: "start", requestId: "attempt-1", context: item.messages, user, assistantId: item.requestId });
  state = chatReducer(state, { type: "metadata", requestId: "attempt-1", metadata: metadata(item) });
  state = chatReducer(state, { type: "delta", requestId: "attempt-1", text: "Partial" });
  state = chatReducer(state, { type: "finish", requestId: "attempt-1", outcome: "interrupted" });
  state = chatReducer(state, { type: "start", requestId: "attempt-2", context: item.messages, userId, assistantId });
  const fake: typeof fetch = async (_url, options) => {
    assert.equal(String(options?.body), original);
    return sse(wire("metadata", metadata(item, true)) + wire("delta", { text: "Partial complete" }) + wire("done", { finishReason: "completed", saved: true }));
  };
  await streamChat(item.messages, new AbortController().signal, text => { state = chatReducer(state, { type: "delta", requestId: "attempt-2", text }); }, fake,
    { requestId: item.requestId, onMetadata: meta => { state = chatReducer(state, { type: "metadata", requestId: "attempt-2", metadata: meta }); } });
  state = chatReducer(state, { type: "finish", requestId: "attempt-2", outcome: "complete" });
  assert.equal(state.messages.length, 2); assert.equal(state.messages[0].id, userId); assert.equal(state.messages[1].id, assistantId);
  assert.equal(state.messages[1].content, "Partial complete"); assert.equal(state.phase, "idle");
});

test("reload restores paginated server messages using only GET, with bounded offsets", async () => {
  const calls: string[] = [];
  const rows = Array.from({ length: 50 }, (_, i) => row(randomUUID(), `Text ${i}`));
  const result = await restoreConversation(conversationId, new AbortController().signal, async (url, options) => {
    calls.push(String(url)); assert.equal(options?.method, "GET"); assert.equal(options?.credentials, "same-origin");
    return calls.length === 1 ? page(0, rows, 50) : page(50, [row(assistantId, "Last")]);
  });
  assert.equal(result.length, 51); assert.equal(result[50].status, "complete");
  assert.deepEqual(calls, [`/api/conversations/${conversationId}?limit=50&offset=0`, `/api/conversations/${conversationId}?limit=50&offset=50`]);
  await assert.rejects(restoreConversation(conversationId, new AbortController().signal, async () => page(0, [], 0)));
});

test("missing/inaccessible conversations surface safe errors without response generation", async () => {
  for (const status of [401, 404, 503]) {
    let calls = 0;
    await assert.rejects(restoreConversation(conversationId, new AbortController().signal, async (_url, options) => {
      calls++; assert.equal(options?.method, "GET");
      return Response.json({ ok: false, error: { code: status === 404 ? "NOT_FOUND" : "STORAGE_UNAVAILABLE", message: "Conversation unavailable." } }, { status });
    }), error => error instanceof ChatStreamError && error.status === status);
    assert.equal(calls, 1);
  }
});

test("pending submission survives reload with exact omitted conversation ID; credentials are excluded", () => {
  const storage = store(), item = intent(); item.metadata = metadata(item); item.partial = "unsaved partial";
  writePending(storage, item);
  const restored = readPending(storage)!;
  assert.equal(restored.requestId, item.requestId); assert.equal(restored.conversationId, undefined);
  assert.equal(restored.metadata?.conversationId, conversationId); assert.deepEqual(restored.messages, item.messages);
  assert.equal(restored.partial, item.partial);
  assert.ok(!storage.getItem(PENDING_KEY)!.includes("MUST_NOT_STORE"));
  storage.setItem(PENDING_KEY, '{"requestId":"invalid","token":"MUST_NOT_STORE"}');
  assert.equal(readPending(storage), null); assert.equal(storage.getItem(PENDING_KEY), null);
  writePending(storage, item); writePending(storage, null); assert.equal(readPending(storage), null);
});

test("reconciliation recovers missing done from server and preserves unsaved partial text as incomplete", () => {
  const item = intent(); item.metadata = metadata(item); item.partial = "Partial received";
  const local = pendingMessages(item);
  const pending = [{ id: userId, role: "user" as const, content: "Hello", status: "complete" as const },
    { id: assistantId, role: "assistant" as const, content: "", status: "pending" as const }];
  const uncertain = reconcileMessages(pending, local, item);
  assert.equal(uncertain.length, 2); assert.equal(uncertain[1].content, item.partial); assert.equal(uncertain[1].status, "pending");
  assert.equal(savedSubmission(pending, item), false);
  const completed = pending.map(message => message.id === assistantId ? { ...message, content: "Saved complete", status: "complete" as const } : message);
  assert.equal(savedSubmission(completed, item), true);
  assert.equal(reconcileMessages(completed, local, item)[1].content, "Saved complete");
});

test("stop/reset invalidate old stream callbacks and restoration stays Idle", () => {
  const item = intent();
  let state = chatReducer(INITIAL_CHAT, { type: "start", requestId: "old", context: item.messages, user: pendingMessages(item)[0] });
  state = chatReducer(state, { type: "metadata", requestId: "old", metadata: metadata(item) });
  state = chatReducer(state, { type: "delta", requestId: "old", text: "Partial" });
  state = chatReducer(state, { type: "settle", requestId: "old" }); assert.equal(state.phase, "idle");
  state = chatReducer(state, { type: "finish", requestId: "old", outcome: "interrupted" });
  assert.equal(state.messages[1].status, "interrupted");
  state = chatReducer(state, { type: "reset" });
  state = chatReducer(state, { type: "metadata", requestId: "old", metadata: metadata(item) });
  state = chatReducer(state, { type: "delta", requestId: "old", text: "Late" });
  assert.deepEqual(state, INITIAL_CHAT);
  state = chatReducer(state, { type: "restore", conversationId, messages: pendingMessages(item) });
  assert.equal(state.phase, "idle"); assert.equal(state.requestId, null);
});

test("in-progress and terminal replay errors preserve backend error codes", async () => {
  const item = intent();
  for (const code of ["REQUEST_IN_PROGRESS", "REQUEST_INTERRUPTED", "REQUEST_FAILED"]) {
    await assert.rejects(streamChat(item.messages, new AbortController().signal, () => {}, async () => Response.json({ ok: false,
      error: { code, message: "Check saved response." } }, { status: 409 }), { requestId: item.requestId, onMetadata() {} }),
      error => error instanceof ChatStreamError && error.code === code && error.status === 409);
  }
});
