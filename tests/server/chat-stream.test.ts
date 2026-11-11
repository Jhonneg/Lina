import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createChatStreamHandler, MAX_STREAM_OUTPUT_BYTES } from "../../src/server/chat-stream-handler";
import { CHAT_LIMITS } from "../../src/server/chat-request";
import { createModelAdapter } from "../../src/server/ai";
import { createMockAdapter, MOCK_RESPONSE } from "../../src/server/ai/mock-adapter";
import { ModelError } from "../../src/server/ai/model-adapter";
import { createOpenAIAdapter, MAX_OUTPUT_TOKENS } from "../../src/server/ai/openai-adapter";

const messages = [{ role: "user" as const, content: "Hello" }];
function request(body: unknown = { messages }, signal?: AbortSignal, headers = {}) {
  return new Request("http://localhost/api/chat/stream", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body), signal,
  });
}
function parse(text: string) {
  return text.split("\n\n").filter(Boolean).map((frame) => {
    const lines = frame.split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^event: (delta|done|error)$/);
    assert.ok(lines[1].startsWith("data: "));
    return { event: lines[0].slice(7), data: JSON.parse(lines[1].slice(6)) };
  });
}
const completed = { event: "done", data: { finishReason: "completed" } };
const encode = new TextEncoder();

test("mock streams timed deterministic chunks, then one done, with SSE headers", async () => {
  const response = await createChatStreamHandler({ getAdapter: () => createMockAdapter("development") })(request());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /^text\/event-stream/);
  assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const reader = response.body!.getReader();
  const first = await reader.read();
  const before = performance.now();
  const second = await reader.read();
  assert.ok(performance.now() - before >= 40, "mock chunks must arrive over time");
  let text = new TextDecoder().decode(first.value) + new TextDecoder().decode(second.value);
  for (;;) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); }
  const events = parse(text);
  assert.ok(events.length > 3);
  assert.deepEqual(events.at(-1), completed);
  assert.ok(events.slice(0, -1).every(({ event }) => event === "delta"));
  assert.equal(events.slice(0, -1).map(({ data }) => data.text).join(""), MOCK_RESPONSE);
});

test("JSON SSE data escapes embedded newlines and event-like text", async () => {
  const text = 'hello\n\nevent: error\ndata: "fake"\n界';
  const handler = createChatStreamHandler({ getAdapter: () => ({ async *stream() { yield text; } }) });
  assert.deepEqual(parse(await (await handler(request())).text()), [{ event: "delta", data: { text } }, completed]);
});

test("invalid requests and production mock configuration fail before SSE opens", async () => {
  let calls = 0;
  const handler = createChatStreamHandler({ getAdapter: () => { calls++; return createMockAdapter("development"); } });
  for (const [req, status] of [
    [request({ messages: [] }), 400],
    [request({ messages: [{ role: "system", content: "x" }] }), 400],
    [request({ messages: [{ role: "user", content: "x".repeat(4001) }] }), 400],
    [request(undefined, undefined, { "Content-Length": String(CHAT_LIMITS.bodyBytes + 1) }), 413],
    [request(undefined, undefined, { Origin: "https://other.example" }), 403],
    [request(undefined, undefined, { "Content-Type": "text/plain" }), 415],
  ] as const) {
    const response = await handler(req);
    assert.equal(response.status, status);
    assert.equal((await response.json()).ok, false);
  }
  assert.equal(calls, 0);
  for (const NODE_ENV of ["production", "test", undefined]) {
    const response = await createChatStreamHandler({ getAdapter: () => createModelAdapter({ NODE_ENV, LAIN_AI_MODE: "mock" }) })(request());
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "AI_NOT_CONFIGURED");
  }
});

test("failure after a delta emits one safe error, no done, and closes the generator", async () => {
  let cleaned = false;
  let providerSignal: AbortSignal | undefined;
  const handler = createChatStreamHandler({ getAdapter: () => ({ async *stream(_messages, signal) {
    providerSignal = signal;
    try { yield "partial"; throw new Error("DO_NOT_LEAK provider credentials"); }
    finally { cleaned = true; }
  } }) });
  const events = parse(await (await handler(request())).text());
  assert.deepEqual(events.map(({ event }) => event), ["delta", "error"]);
  assert.equal(events[1].data.code, "INTERNAL_ERROR");
  assert.ok(!JSON.stringify(events).includes("DO_NOT_LEAK"));
  assert.ok(cleaned);
  assert.ok(providerSignal?.aborted);
});

test("empty output, oversized UTF-8 output, and model failures never emit done", async () => {
  for (const kind of ["empty", "oversize", "upstream", "timeout"] as const) {
    const response = await createChatStreamHandler({ getAdapter: () => ({ async *stream() {
      if (kind === "oversize") yield "界".repeat(Math.ceil(MAX_STREAM_OUTPUT_BYTES / 3));
      else if (kind !== "empty") throw new ModelError(kind);
    } }) })(request());
    const events = parse(await response.text());
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "error");
    assert.equal(events[0].data.code, kind === "timeout" ? "AI_TIMEOUT" : "AI_UNAVAILABLE");
  }
});

test("deadline closes a stalled iterator and aborts provider even if it ignores the signal", { timeout: 1000 }, async () => {
  let signal: AbortSignal | undefined;
  let returned = 0;
  const response = await createChatStreamHandler({ timeoutMs: 20, getAdapter: () => ({ stream(_messages, value) {
    signal = value;
    return { [Symbol.asyncIterator]() { return {
      next: () => new Promise<IteratorResult<string>>(() => {}),
      return: async () => { returned++; return { done: true, value: undefined }; },
    }; } };
  } }) })(request());
  const events = parse(await response.text());
  assert.equal(events[0].data.code, "AI_TIMEOUT");
  assert.ok(signal?.aborted);
  assert.equal(returned, 1);
});

test("deadline also releases an unread stream without starting the provider", { timeout: 1000 }, async () => {
  let started = false;
  const response = await createChatStreamHandler({ timeoutMs: 15, getAdapter: () => ({ async *stream() { started = true; yield "unused"; } }) })(request());
  await delay(30);
  assert.equal(parse(await response.text())[0].data.code, "AI_TIMEOUT");
  assert.equal(started, false);
});

test("reader cancellation and request disconnect abort work and execute generator cleanup", { timeout: 1000 }, async () => {
  for (const disconnect of [false, true]) {
    const abort = new AbortController();
    let cleaned = false;
    let providerSignal: AbortSignal | undefined;
    const response = await createChatStreamHandler({ getAdapter: () => ({ async *stream(_messages, signal) {
      providerSignal = signal;
      try { yield "first"; await delay(10_000, undefined, { signal }); yield "never"; }
      finally { cleaned = true; }
    } }) })(request(undefined, abort.signal));
    const reader = response.body!.getReader();
    assert.equal(parse(new TextDecoder().decode((await reader.read()).value))[0].data.text, "first");
    const pending = reader.read();
    if (disconnect) abort.abort(); else await reader.cancel();
    assert.equal((await pending).done, true);
    await delay(0);
    assert.ok(providerSignal?.aborted);
    assert.ok(cleaned);
  }
});

test("already-aborted requests and slow uploads never create an adapter", { timeout: 1000 }, async () => {
  let calls = 0;
  const handler = createChatStreamHandler({ timeoutMs: 15, getAdapter: () => { calls++; return createMockAdapter("development"); } });
  const abort = new AbortController(); abort.abort();
  assert.equal((await handler(request(undefined, abort.signal))).status, 408);
  let cancelled = false;
  const req = new Request("http://localhost/api/chat/stream", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: new ReadableStream({ cancel() { cancelled = true; } }), duplex: "half",
  } as RequestInit);
  assert.equal((await handler(req)).status, 504);
  assert.ok(cancelled);
  assert.equal(calls, 0);
});

function providerEvent(type: string, extra: object = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
}

test("OpenAI adapter uses Responses streaming with fixed safety options and releases its reader", async () => {
  let cancelled = false;
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.equal(body.model, "unit-test-model");
    assert.equal(body.max_output_tokens, MAX_OUTPUT_TOKENS);
    assert.deepEqual(body.input, messages);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encode.encode(providerEvent("response.output_text.delta", { delta: "Hello " }) +
          providerEvent("response.output_text.delta", { delta: "world" }) +
          providerEvent("response.completed", { response: { status: "completed" } })));
      },
      cancel() { cancelled = true; },
    }), { headers: { "Content-Type": "text/event-stream" } });
  };
  const adapter = createOpenAIAdapter({ apiKey: "fake-test-key", model: "unit-test-model" }, fakeFetch);
  const chunks = [];
  for await (const chunk of adapter.stream(messages, new AbortController().signal)) chunks.push(chunk);
  assert.deepEqual(chunks, ["Hello ", "world"]);
  assert.ok(cancelled);
});

test("OpenAI stream rejects provider errors and truncated/incomplete streams without leaking details", async () => {
  for (const ending of ["response.failed", "response.incomplete", "error", "EOF", "HTTP"]) {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls++;
      if (ending === "HTTP") return new Response('{"error":{"message":"DO_NOT_LEAK"}}', { status: 401 });
      const text = providerEvent("response.output_text.delta", { delta: "partial" }) +
        (ending === "EOF" ? "" : providerEvent(ending, { message: "DO_NOT_LEAK" }));
      return new Response(text, { headers: { "Content-Type": "text/event-stream" } });
    };
    const adapter = createOpenAIAdapter({ apiKey: "fake-test-key", model: "unit-test-model" }, fakeFetch);
    const events = parse(await (await createChatStreamHandler({ getAdapter: () => adapter })(request())).text());
    assert.equal(events.at(-1)?.event, "error");
    assert.equal(events.at(-1)?.data.code, "AI_UNAVAILABLE");
    assert.ok(!JSON.stringify(events).includes("DO_NOT_LEAK"));
    assert.equal(calls, 1);
  }
});
