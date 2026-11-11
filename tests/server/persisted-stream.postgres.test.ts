import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDatabase } from "../../src/server/db";
import { conversations, messages, sessions, streamRequests } from "../../src/server/db/schema";
import { createSessionService, sessionCookieSettings } from "../../src/server/sessions";
import { createChatStreamHandler } from "../../src/server/chat-stream-handler";
import { createStreamPersistence, type StreamClaim } from "../../src/server/stream-persistence";
import { createConversationRepository } from "../../src/server/conversations/repository";
import { ModelError } from "../../src/server/ai/model-adapter";
import type { PersistedStreamInput } from "../../src/server/persisted-stream-request";

const designated = process.env.LAIN_STREAM_INTEGRATION_DATABASE;
const target = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/disabled");
if (!designated || !/^lain_stream_it_[a-f0-9]{16}$/.test(designated) || target.pathname !== `/${designated}` ||
    !["localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("Refusing tests outside the designated disposable database.");
function payload(content = "Hello", conversationId?: string): PersistedStreamInput {
  return { mode: "persisted", requestId: randomUUID(), conversationId, messages: [{ role: "user", content }] };
}
function request(body: PersistedStreamInput, token?: string, signal?: AbortSignal, origin = "http://localhost") {
  return new Request("http://localhost/api/chat/stream", { method: "POST", signal,
    headers: { "Content-Type": "application/json", Origin: origin, ...(token ? { Cookie: `${sessionCookieSettings().name}=${token}` } : {}) },
    body: JSON.stringify(body) });
}
function frames(text: string) {
  return text.split("\n\n").filter(Boolean).map(frame => { const [event, data] = frame.split("\n"); return { event: event.slice(7), data: JSON.parse(data.slice(6)) }; });
}
async function check(t: TestContext, name: string, fn: () => Promise<void>) {
  await t.test(name, async () => { try { await fn(); } catch { assert.fail(`${name}: check failed; private details withheld.`); } });
}

test("PostgreSQL persisted streaming", { timeout: 45000 }, async t => {
  const db = getDatabase(), persistence = createStreamPersistence(), sessionService = createSessionService();
  let generations = 0;
  const handler = createChatStreamHandler({ getAdapter: () => ({ async *stream() { generations++; yield "Hello "; yield "there"; } }) });
  try {
    await migrate(db, { migrationsFolder: "drizzle" });
    const first = await sessionService.getOrCreateSession(undefined), second = await sessionService.getOrCreateSession(undefined);
    const owner = first.session.id, token = first.newToken!, other = second.newToken!;
    const initial = payload(); let conversationId = "";
    const row = async (id: string, sessionId = owner) => (await db.select().from(streamRequests)
      .where(and(eq(streamRequests.requestId, id), eq(streamRequests.sessionId, sessionId))))[0];
    const assistant = async (id: string) => (await db.select().from(messages).where(eq(messages.id, id)))[0];
    const counts = async () => ({
      conversations: (await db.select({ count: sql<number>`count(*)::int` }).from(conversations))[0].count,
      messages: (await db.select({ count: sql<number>`count(*)::int` }).from(messages))[0].count,
      requests: (await db.select({ count: sql<number>`count(*)::int` }).from(streamRequests))[0].count,
    });
    await check(t, "first request durably creates conversation, user and pending assistant before metadata", async () => {
      const response = await handler(request(initial, token));
      assert.ok(response.status === 200);
      const reader = response.body!.getReader(), decoder = new TextDecoder();
      const metadata = frames(decoder.decode((await reader.read()).value))[0];
      assert.ok(metadata.event === "metadata" && metadata.data.replayed === false);
      assert.equal(Number(generations), 0);
      conversationId = metadata.data.conversationId;
      const record = await row(initial.requestId);
      assert.ok(record.state === "running" && record.conversationId === conversationId);
      assert.ok(record.userMessageId === metadata.data.userMessageId && record.assistantMessageId === metadata.data.assistantMessageId);
      assert.ok((await assistant(record.assistantMessageId)).status === "pending");
      assert.ok((await assistant(record.userMessageId)).content === "Hello");
      let wire = "";
      for (;;) { const part = await reader.read(); if (part.done) break; wire += decoder.decode(part.value); }
      const events = frames(wire);
      assert.ok(events.map(x => x.event).join(",") === "delta,delta,done");
      assert.ok(events.at(-1)!.data.saved === true);
      const saved = await row(initial.requestId), message = await assistant(saved.assistantMessageId);
      assert.ok(saved.state === "completed" && message.status === "completed" && message.content === "Hello there");
      assert.ok((await counts()).messages === 2 && generations === 1);
    });
    await check(t, "completed retries replay the same message IDs without new rows or generation", async () => {
      const before = await counts(), calls = generations;
      const events = frames(await (await handler(request(initial, token))).text());
      const record = await row(initial.requestId);
      assert.ok(events[0].event === "metadata" && events[0].data.replayed === true);
      assert.ok(events[0].data.assistantMessageId === record.assistantMessageId && events.at(-1)!.event === "done");
      assert.ok(JSON.stringify(before) === JSON.stringify(await counts()) && generations === calls);
      const conflict = await handler(request({ ...initial, messages: [{ role: "user", content: "Changed" }] }, token));
      assert.ok(conflict.status === 409 && (await conflict.json()).error.code === "REQUEST_CONFLICT");
    });
    await check(t, "follow-up appends only the newest user message to the owned conversation", async () => {
      const follow = payload("Next", conversationId);
      follow.messages = [...initial.messages, { role: "assistant", content: "Hello there" }, ...follow.messages];
      const events = frames(await (await handler(request(follow, token))).text());
      assert.ok(events[0].data.conversationId === conversationId && events.at(-1)!.event === "done");
      const history = await createConversationRepository().get(owner, conversationId);
      assert.ok(history!.messages.length === 4 && history!.messages.filter(x => x.role === "user").length === 2);
      assert.ok((await counts()).conversations === 1);
    });
    await check(t, "cross-session UUIDs, missing sessions and wrong origins cannot mutate storage", async () => {
      const before = await counts();
      const foreign = await handler(request(payload("Blocked", conversationId), other));
      const missing = await handler(request(payload("Blocked", randomUUID()), other));
      assert.ok(foreign.status === 404 && JSON.stringify(await foreign.json()) === JSON.stringify(await missing.json()));
      for (const value of [undefined, "invalid"]) assert.ok((await handler(request(payload(), value))).status === 401);
      assert.ok((await handler(request(payload(), token, undefined, "https://other.example"))).status === 403);
      assert.ok(JSON.stringify(before) === JSON.stringify(await counts()));
      const expired = await sessionService.getOrCreateSession(undefined);
      await db.update(sessions).set({ expiresAt: new Date(0) }).where(eq(sessions.id, expired.session.id));
      assert.ok((await handler(request(payload(), expired.newToken))).status === 401);
    });
    await check(t, "concurrent identical requests claim exactly one generation and one user/assistant pair", async () => {
      const input = payload("Concurrent", conversationId), calls = generations, before = await counts();
      const responses = await Promise.all([handler(request(input, token)), handler(request(input, token))]);
      const active = responses.find(x => x.status === 200)!, busy = responses.find(x => x.status === 409)!;
      assert.ok(Boolean(active) && Boolean(busy) && (await busy.json()).error.code === "REQUEST_IN_PROGRESS");
      assert.ok(frames(await active.text()).at(-1)!.event === "done");
      assert.ok(generations === calls + 1 && (await counts()).messages === before.messages + 2);
      assert.ok((await db.select().from(streamRequests).where(eq(streamRequests.requestId, input.requestId))).length === 1);
    });
    await check(t, "same request UUID is independently scoped to each verified session", async () => {
      const duplicateId = { ...initial, messages: [{ role: "user" as const, content: "Other session" }] };
      const events = frames(await (await handler(request(duplicateId, other))).text());
      assert.ok(events[0].data.conversationId !== conversationId && events.at(-1)!.event === "done");
      assert.ok((await row(initial.requestId, second.session.id)).conversationId !== conversationId);
    });
    await check(t, "cancellation preserves partial text as interrupted and a retry replays without regeneration", async () => {
      const input = payload("Cancel", conversationId); let calls = 0;
      const cancelHandler = createChatStreamHandler({ getAdapter: () => ({ async *stream(_m, signal) { calls++; yield "Partial"; await delay(10000, undefined, { signal }); } }) });
      const response = await cancelHandler(request(input, token)), reader = response.body!.getReader();
      await reader.read(); await reader.read(); const pending = reader.read(); await reader.cancel(); await pending;
      const record = await row(input.requestId), message = await assistant(record.assistantMessageId);
      assert.ok(record.state === "interrupted" && message.status === "interrupted" && message.content === "Partial");
      const replay = frames(await (await cancelHandler(request(input, token))).text());
      assert.ok(replay[1].data.text === "Partial" && replay.at(-1)!.data.code === "REQUEST_INTERRUPTED" && calls === 1);
    });
    await check(t, "AbortSignal disconnect saves partial output before the worker finishes cleanup", async () => {
      const input = payload("Disconnect", conversationId), abort = new AbortController();
      const disconnected = createChatStreamHandler({ getAdapter: () => ({ async *stream(_m, signal) { yield "Before disconnect"; await delay(10000, undefined, { signal }); } }) });
      const response = await disconnected(request(input, token, abort.signal)), reader = response.body!.getReader();
      await reader.read(); await reader.read(); const pending = reader.read(); abort.abort(); await pending;
      for (let n = 0; n < 100 && (await row(input.requestId)).state === "running"; n++) await delay(10);
      const record = await row(input.requestId);
      assert.ok(record.state === "interrupted" && (await assistant(record.assistantMessageId)).content === "Before disconnect");
    });
    await check(t, "upstream failure and timeout preserve partial text as failed with SSE error and no done", async () => {
      for (const timeout of [false, true]) {
        const input = payload(timeout ? "Timeout" : "Failure", conversationId);
        const failing = createChatStreamHandler({ timeoutMs: timeout ? 150 : 25000, getAdapter: () => ({ async *stream(_m, signal) {
          yield "Partial failure"; if (timeout) await delay(10000, undefined, { signal }); else throw new ModelError("upstream");
        } }) });
        const events = frames(await (await failing(request(input, token))).text()), record = await row(input.requestId);
        assert.ok(events.at(-1)!.event === "error" && events.at(-1)!.data.code === (timeout ? "AI_TIMEOUT" : "AI_UNAVAILABLE"));
        assert.ok(!events.some(x => x.event === "done") && record.state === "failed");
        assert.ok((await assistant(record.assistantMessageId)).content === "Partial failure");
      }
    });
    await check(t, "claim database failure rolls back conversation and messages before streaming", async () => {
      const before = await counts();
      await db.execute(sql`CREATE FUNCTION fail_stream_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_FAILURE'; END $$`);
      await db.execute(sql`CREATE TRIGGER fail_stream_claim BEFORE INSERT ON stream_requests FOR EACH ROW EXECUTE FUNCTION fail_stream_claim()`);
      try {
        const failed = await handler(request(payload("Rollback"), token));
        assert.ok(failed.status === 503 && (await failed.json()).error.code === "PERSISTENCE_UNAVAILABLE");
        assert.ok(JSON.stringify(before) === JSON.stringify(await counts()));
      } finally { await db.execute(sql`DROP TRIGGER fail_stream_claim ON stream_requests`); await db.execute(sql`DROP FUNCTION fail_stream_claim()`); }
    });
    await check(t, "final-save failure never emits done; stale claims recover without regeneration or late overwrite", async () => {
      const input = payload("Final save", conversationId);
      await db.execute(sql`CREATE FUNCTION fail_stream_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_FAILURE'; END $$`);
      await db.execute(sql`CREATE TRIGGER fail_stream_save BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION fail_stream_save()`);
      try {
        const events = frames(await (await handler(request(input, token))).text());
        assert.ok(events.at(-1)!.data.code === "PERSISTENCE_UNAVAILABLE" && !events.some(x => x.event === "done"));
        const pending = await row(input.requestId);
        assert.ok(pending.state === "running" && (await assistant(pending.assistantMessageId)).status === "pending");
      } finally { await db.execute(sql`DROP TRIGGER fail_stream_save ON messages`); await db.execute(sql`DROP FUNCTION fail_stream_save()`); }
      const pending = await row(input.requestId), before = await counts(), calls = generations;
      assert.ok((await handler(request(input, token))).status === 409);
      await db.update(streamRequests).set({ staleAt: new Date(0) }).where(eq(streamRequests.id, pending.id));
      const replay = frames(await (await handler(request(input, token))).text());
      assert.ok(replay[0].data.replayed === true && replay.at(-1)!.data.code === "REQUEST_FAILED");
      assert.ok((await row(input.requestId)).state === "failed" && generations === calls && JSON.stringify(before) === JSON.stringify(await counts()));
      const late: StreamClaim = { ...pending, isNew: true, content: "" };
      let rejected = false;
      try { await persistence.finish(late, "Late result", "completed"); } catch { rejected = true; }
      assert.ok(rejected && (await assistant(pending.assistantMessageId)).content === "");
    });
    await check(t, "database uniqueness enforces idempotency independently of advisory locks", async () => {
      const original = await row(initial.requestId), repository = createConversationRepository();
      const user = await repository.appendMessage(owner, conversationId, { role: "user", content: "Constraint fixture" });
      const answer = await repository.appendMessage(owner, conversationId, { role: "assistant", content: "Constraint fixture" });
      let constraint;
      try {
        await db.insert(streamRequests).values({ sessionId: owner, requestId: initial.requestId, fingerprint: original.fingerprint,
          conversationId, userMessageId: user!.id, assistantMessageId: answer!.id, staleAt: new Date(Date.now() + 60000) });
      } catch (error) { constraint = (error as { cause?: { constraint?: string } }).cause?.constraint; }
      assert.ok(constraint === "stream_requests_session_request_unique");
    });
  } catch { assert.fail("Streaming PostgreSQL setup failed; private details withheld."); }
  finally { await db.$client.end(); }
});
