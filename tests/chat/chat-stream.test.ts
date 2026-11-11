import assert from "node:assert/strict";
import { test } from "node:test";
import { chatReducer, conversationContext, INITIAL_CHAT, type ChatState } from "../../src/components/chat/chat-state";
import { streamChat } from "../../src/components/chat/chat-stream";

const context = [{ role: "user" as const, content: "Hello" }];
const user = { id: "user-1", ...context[0] };
const encoder = new TextEncoder();
const done = 'event: done\ndata: {"finishReason":"completed"}\n\n';
function delta(text: string) { return `event: delta\ndata: ${JSON.stringify({ text })}\n\n`; }
function transport(chunks: Uint8Array[], cancel = () => {}): typeof fetch {
  return async (url, options) => {
    assert.equal(url, "/api/chat/stream");
    assert.equal(options?.method, "POST");
    assert.deepEqual(JSON.parse(String(options?.body)), { messages: context });
    assert.equal(new Headers(options?.headers).get("accept"), "text/event-stream");
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { const value = chunks.shift(); if (value) controller.enqueue(value); else controller.close(); },
      cancel,
    }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
  };
}
async function read(chunks: Uint8Array[]) {
  const output: string[] = [];
  await streamChat(context, new AbortController().signal, text => output.push(text), transport(chunks));
  return output;
}

test("frontend parses split SSE lines/frames and split CRLF at every byte boundary", async () => {
  const wire = (delta("hello") + delta(" world") + done).replaceAll("\n", "\r\n");
  const bytes = encoder.encode(wire);
  assert.deepEqual(await read(Array.from(bytes, byte => Uint8Array.of(byte))), ["hello", " world"]);
  for (let split = 1; split < bytes.length; split++) {
    assert.deepEqual(await read([bytes.slice(0, split), bytes.slice(split)]), ["hello", " world"]);
  }
});

test("frontend handles multiple events per chunk, comments, multiline JSON and escaped newlines", async () => {
  const wire = ': heartbeat\n\nevent: delta\ndata: {\ndata: "text":"hello\\nworld"}\n\n' + delta("") + done;
  assert.deepEqual(await read([encoder.encode(wire)]), ["hello\nworld"]);
});

test("frontend preserves UTF-8 when multibyte characters span network chunks", async () => {
  const text = "Olá — 世界 🌙";
  const bytes = encoder.encode(delta(text) + done);
  assert.deepEqual(await read(Array.from(bytes, byte => Uint8Array.of(byte))), [text]);
});

test("done completes the response and cancels/releases an otherwise open reader", async () => {
  let cancelled = false;
  let source: ReadableStream<Uint8Array> | undefined;
  const fake: typeof fetch = async () => {
    source = new ReadableStream({ start(c) { c.enqueue(encoder.encode(delta("reply") + done)); }, cancel() { cancelled = true; } });
    return new Response(source, { headers: { "Content-Type": "text/event-stream" } });
  };
  await streamChat(context, new AbortController().signal, () => {}, fake);
  assert.ok(cancelled);
  assert.equal(source?.locked, false);
});

test("SSE errors preserve partial text and release resources without completion", async () => {
  const output: string[] = [];
  let cancelled = false;
  const fake: typeof fetch = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(encoder.encode(delta("partial") + 'event: error\ndata: {"code":"AI_TIMEOUT","message":"Please try again."}\n\n')); },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/event-stream" } });
  await assert.rejects(streamChat(context, new AbortController().signal, x => output.push(x), fake), /Please try again/);
  assert.deepEqual(output, ["partial"]);
  assert.ok(cancelled);
});

test("unexpected EOF, truncated frames and malformed events reject without done", async () => {
  for (const wire of ["", delta("partial"), done.trimEnd(), 'event: delta\ndata: invalid\n\n',
    'event: delta\ndata: {"text":42}\n\n', 'event: done\ndata: {"finishReason":"failed"}\n\n']) {
    await assert.rejects(read([encoder.encode(wire)]));
  }
});

test("non-2xx JSON errors are handled before SSE, with safe fallbacks for HTML/network failures", async () => {
  const json: typeof fetch = async () => Response.json({ ok: false, error: { code: "AI_NOT_CONFIGURED", message: "The AI service is not configured." } }, { status: 503 });
  await assert.rejects(streamChat(context, new AbortController().signal, () => {}, json), /not configured/);
  const html: typeof fetch = async () => new Response("DO_NOT_LEAK proxy failure", { status: 502 });
  await assert.rejects(streamChat(context, new AbortController().signal, () => {}, html), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes("DO_NOT_LEAK")); return true;
  });
  const invalidType: typeof fetch = async () => Response.json({ text: "unexpected" });
  await assert.rejects(streamChat(context, new AbortController().signal, () => {}, invalidType), /Unable to read/);
});

test("Stop cancels a pending reader, keeps received text and restores Idle", async () => {
  const abort = new AbortController();
  let state = chatReducer(INITIAL_CHAT, { type: "start", requestId: "reply", context, user });
  let cancelled = false;
  const fake: typeof fetch = async (_url, options) => {
    assert.equal(options?.signal, abort.signal);
    return new Response(new ReadableStream({
      start(c) { c.enqueue(encoder.encode(delta("partial"))); }, cancel() { cancelled = true; },
    }), { headers: { "Content-Type": "text/event-stream" } });
  };
  const running = streamChat(context, abort.signal, text => {
    state = chatReducer(state, { type: "delta", requestId: "reply", text });
    abort.abort();
    state = chatReducer(state, { type: "finish", requestId: "reply", outcome: "interrupted" });
  }, fake);
  await assert.rejects(running, { name: "AbortError" });
  assert.ok(cancelled);
  assert.equal(state.phase, "idle");
  assert.equal(state.messages[1].content, "partial");
  assert.equal(state.messages[1].status, "interrupted");
});

test("New Chat aborts work and rejects late events even after a newer request starts", async () => {
  const abort = new AbortController();
  let state: ChatState = chatReducer(INITIAL_CHAT, { type: "start", requestId: "old", context, user });
  let cancelled = false;
  let ready!: () => void;
  const opened = new Promise<void>(resolve => { ready = resolve; });
  const fake: typeof fetch = async () => new Response(new ReadableStream({
    start(c) { c.enqueue(encoder.encode(delta("old partial"))); }, cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/event-stream" } });
  const running = streamChat(context, abort.signal, text => {
    state = chatReducer(state, { type: "delta", requestId: "old", text }); ready();
  }, fake);
  await opened;
  abort.abort();
  state = chatReducer(state, { type: "reset" });
  await assert.rejects(running, { name: "AbortError" });
  assert.ok(cancelled);
  assert.deepEqual(state, INITIAL_CHAT);
  state = chatReducer(state, { type: "start", requestId: "new", context, user });
  const expected = state;
  for (const action of [
    { type: "delta" as const, requestId: "old", text: "late" },
    { type: "finish" as const, requestId: "old", outcome: "complete" as const },
  ]) state = chatReducer(state, action);
  assert.equal(state, expected);
});

test("retry preserves the user/partial response, creates one new assistant response and reuses context", () => {
  let state = chatReducer(INITIAL_CHAT, { type: "start", requestId: "first", context, user });
  assert.equal(state.phase, "thinking");
  state = chatReducer(state, { type: "delta", requestId: "first", text: "" });
  assert.equal(state.messages.length, 1);
  state = chatReducer(state, { type: "delta", requestId: "first", text: "partial" });
  assert.equal(state.phase, "talking");
  state = chatReducer(state, { type: "finish", requestId: "first", outcome: "interrupted", error: "Please retry" });
  state = chatReducer(state, { type: "start", requestId: "retry", context: state.retryContext });
  assert.deepEqual(state.retryContext, context);
  for (const text of ["new", " reply"]) state = chatReducer(state, { type: "delta", requestId: "retry", text });
  state = chatReducer(state, { type: "finish", requestId: "retry", outcome: "complete" });
  assert.equal(state.messages.filter(x => x.role === "user").length, 1);
  assert.equal(state.messages.length, 3);
  assert.equal(state.messages[1].content, "partial");
  assert.equal(state.messages[2].content, "new reply");
  assert.equal(state.messages[2].status, "complete");
  assert.equal(state.phase, "idle");
  assert.equal(state.error, null);
});

test("bounded context selects recent messages without UI IDs/status, partial replies or oversized JSON", () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ id: String(i), role: "user" as const, content: "Hello" }));
  assert.equal(conversationContext(history).length, 20);
  const long = [{ id: "long", role: "assistant" as const, content: "a".repeat(3999) + "🌙tail", status: "complete" as const }];
  const bounded = conversationContext([...long, user]);
  assert.equal(bounded[0].content.length, 3999);
  assert.deepEqual(Object.keys(bounded[0]), ["role", "content"]);
  const unicode = Array.from({ length: 4 }, (_, i) => ({ id: String(i), role: "user" as const, content: "界".repeat(4000) }));
  const result = conversationContext(unicode);
  assert.ok(result.length > 0);
  assert.ok(encoder.encode(JSON.stringify({ messages: result })).byteLength <= 32768);
  assert.ok(result.reduce((n, x) => n + x.content.length, 0) <= 12000);
  assert.deepEqual(conversationContext([user, { id: "partial", role: "assistant", content: "unfinished", status: "interrupted" }]), context);
});
