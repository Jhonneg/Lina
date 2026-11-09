import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { createChatHandler } from "../../src/server/chat-handler";
import { CHAT_LIMITS, validateMessages } from "../../src/server/chat-request";
import { createModelAdapter } from "../../src/server/ai";
import { ModelError, type ModelAdapter } from "../../src/server/ai/model-adapter";
import { createMockAdapter, MOCK_RESPONSE } from "../../src/server/ai/mock-adapter";
import { createOpenAIAdapter, MAX_OUTPUT_TOKENS } from "../../src/server/ai/openai-adapter";

// Even an accidentally configured SDK client cannot make a billable call here.
const network = mock.method(globalThis, "fetch", async () => { throw new Error("Network disabled in unit tests"); });
after(() => { assert.equal(network.mock.callCount(), 0); network.mock.restore(); });

const valid = { messages: [{ role: "user", content: " Hello " }] };
const handler = createChatHandler({ getAdapter: () => createMockAdapter("development") });
function request(body: unknown = valid, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}
function streamRequest(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body, duplex: "half",
  } as RequestInit);
}
async function expectError(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, "string");
  assert.equal(JSON.stringify(body).includes("DO_NOT_LEAK"), false);
}

test("validates explicit roles, trims content and accepts inclusive boundaries", () => {
  assert.deepEqual(validateMessages({ messages: [{ role: "assistant", content: " Prior reply " }, ...valid.messages] }), [
    { role: "assistant", content: "Prior reply" }, { role: "user", content: "Hello" },
  ]);
  assert.equal(validateMessages({ messages: Array.from({ length: 20 }, () => ({ role: "user", content: "a".repeat(600) })) }).length, 20);
  assert.equal(validateMessages({ messages: Array.from({ length: 3 }, () => ({ role: "user", content: "a".repeat(4000) })) }).length, 3);
});

test("rejects malformed shapes, privileged roles, blank/long content and excessive counts", async () => {
  const bodies = [
    null, [], {}, { messages: [] }, { messages: "not an array" },
    { ...valid, model: "client-selected-model" }, { messages: [null] },
    { messages: [{ role: "system", content: "DO_NOT_LEAK" }] },
    { messages: [{ role: "developer", content: "DO_NOT_LEAK" }] },
    { messages: [{ role: "user", content: 7 }] },
    { messages: [{ role: "user", content: " \n " }] },
    { messages: [{ role: "user", content: "ok", id: "extra" }] },
    { messages: [{ role: "user", content: "a".repeat(4001) }] },
    { messages: Array.from({ length: 21 }, () => valid.messages[0]) },
    { messages: Array.from({ length: 4 }, () => ({ role: "user", content: "a".repeat(3001) })) },
  ];
  for (const body of bodies) await expectError(await handler(request(body)), 400, "INVALID_REQUEST");
});

test("development mock returns a deterministic assistant envelope without network access", async () => {
  const adapter = createModelAdapter({ LAIN_AI_MODE: "mock", NODE_ENV: "development" });
  const response = await createChatHandler({ getAdapter: () => adapter })(request(valid, { Origin: "http://localhost" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, message: { role: "assistant", content: MOCK_RESPONSE } });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(await adapter.generate([{ role: "assistant", content: "Different input" }], new AbortController().signal), MOCK_RESPONSE);
});

test("mock fails closed outside development and real mode requires explicit configuration", () => {
  for (const NODE_ENV of [undefined, "test", "production"]) {
    assert.throws(() => createModelAdapter({ NODE_ENV, LAIN_AI_MODE: "mock" }), ModelError);
  }
  for (const env of [
    {}, { OPENAI_API_KEY: "dummy" }, { OPENAI_MODEL: "unit-test-model" },
    { OPENAI_API_KEY: "dummy", OPENAI_MODEL: "  " }, { LAIN_AI_MODE: "unknown" },
  ]) assert.throws(() => createModelAdapter(env), ModelError);
});

test("rejects unsupported media, compressed bodies and cross-origin requests", async () => {
  await expectError(await handler(request(valid, { "Content-Type": "text/plain" })), 415, "UNSUPPORTED_MEDIA_TYPE");
  await expectError(await handler(request(valid, { "Content-Encoding": "gzip" })), 415, "UNSUPPORTED_MEDIA_TYPE");
  const origins: Record<string, string>[] = [{ Origin: "https://other.example" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }];
  for (const headers of origins) {
    await expectError(await handler(request(valid, headers)), 403, "FORBIDDEN_ORIGIN");
  }
});

test("malformed JSON, invalid UTF-8 and absent bodies return safe input errors", async () => {
  for (const body of ["{DO_NOT_LEAK", new Uint8Array([0xc3, 0x28]), null]) {
    await expectError(await handler(new Request("http://localhost/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    })), 400, "INVALID_REQUEST");
  }
});

test("enforces actual UTF-8 bytes on chunked bodies, even with a false small length", async () => {
  await expectError(await handler(request(valid, { "Content-Length": String(CHAT_LIMITS.bodyBytes + 1) })), 413, "PAYLOAD_TOO_LARGE");
  const bytes = new TextEncoder().encode(JSON.stringify({ messages: Array.from({ length: 3 }, () => ({ role: "user", content: "界".repeat(4000) })) }));
  let offset = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + 1024));
      offset += 1024;
    },
    cancel() { cancelled = true; },
  });
  await expectError(await handler(streamRequest(stream, { "Content-Length": "1" })), 413, "PAYLOAD_TOO_LARGE");
  assert.equal(cancelled, true);
  const json = JSON.stringify(valid);
  const exact = json + " ".repeat(CHAT_LIMITS.bodyBytes - new TextEncoder().encode(json).length);
  assert.equal((await handler(new Request("http://localhost/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: exact }))).status, 200);
});

test("maps configuration, upstream, timeout and unexpected failures without raw errors", async () => {
  for (const [error, status, code] of [
    [new ModelError("configuration"), 503, "AI_NOT_CONFIGURED"],
    [new ModelError("upstream"), 502, "AI_UNAVAILABLE"],
    [new ModelError("timeout"), 504, "AI_TIMEOUT"],
    [new Error("DO_NOT_LEAK credentials or conversation"), 500, "INTERNAL_ERROR"],
  ] as const) {
    const failed = createChatHandler({ getAdapter: () => ({ async generate() { throw error; } }) });
    await expectError(await failed(request()), status, code);
  }
  const missing = createChatHandler({ getAdapter: () => createModelAdapter({}) });
  await expectError(await missing(request()), 503, "AI_NOT_CONFIGURED");
  const empty = createChatHandler({ getAdapter: () => ({ async generate() { return " "; } }) });
  await expectError(await empty(request()), 502, "AI_UNAVAILABLE");
});

test("deadline bounds a stalled adapter and cancels a stalled request body", { timeout: 1000 }, async () => {
  const stalled: ModelAdapter = { generate: () => new Promise(() => {}) };
  await expectError(await createChatHandler({ getAdapter: () => stalled, timeoutMs: 10 })(request()), 504, "AI_TIMEOUT");
  let cancelled = false;
  let adapterUsed = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const slowBody = createChatHandler({ timeoutMs: 10, getAdapter: () => { adapterUsed = true; return stalled; } });
  await expectError(await slowBody(streamRequest(stream)), 504, "AI_TIMEOUT");
  assert.equal(cancelled, true);
  assert.equal(adapterUsed, false);
});

test("client cancellation does not start model work", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const cancelled = createChatHandler({ getAdapter: () => { called = true; return createMockAdapter("development"); } });
  await expectError(await cancelled(new Request(request(), { signal: controller.signal })), 408, "REQUEST_ABORTED");
  assert.equal(called, false);
});

test("official SDK uses Responses, configured model, bounded output and no stored response", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), "https://api.openai.com/v1/responses");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "unit-test-model");
    assert.equal(body.store, false);
    assert.equal(body.stream, false);
    assert.equal(body.max_output_tokens, MAX_OUTPUT_TOKENS);
    assert.deepEqual(body.input, [{ role: "user", content: "Hello" }]);
    return Response.json({ object: "response", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: " SDK reply ", annotations: [] }] }] });
  };
  const adapter = createOpenAIAdapter({ apiKey: "not-a-real-key", model: "unit-test-model" }, fakeFetch);
  const response = await createChatHandler({ getAdapter: () => adapter })(request());
  assert.deepEqual(await response.json(), { ok: true, message: { role: "assistant", content: "SDK reply" } });
  assert.equal(calls, 1);
});

test("SDK failures are sanitized, not retried, and incomplete output is rejected", async () => {
  let calls = 0;
  const failedFetch: typeof fetch = async () => {
    calls++;
    return Response.json({ error: { message: "DO_NOT_LEAK provider details", type: "authentication_error" } }, { status: 401 });
  };
  const failed = createOpenAIAdapter({ apiKey: "not-a-real-key", model: "unit-test-model" }, failedFetch);
  await expectError(await createChatHandler({ getAdapter: () => failed })(request()), 502, "AI_UNAVAILABLE");
  assert.equal(calls, 1);
  for (const payload of [{ status: "incomplete", output: [] }, { status: "completed", output: [] }]) {
    const fakeFetch: typeof fetch = async () => Response.json({ object: "response", ...payload });
    const adapter = createOpenAIAdapter({ apiKey: "not-a-real-key", model: "unit-test-model" }, fakeFetch);
    await expectError(await createChatHandler({ getAdapter: () => adapter })(request()), 502, "AI_UNAVAILABLE");
  }
});
