import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
import { getDatabase } from "../../src/server/db";
import { sessions, usageReservations, usageUtterances, conversations, messages } from "../../src/server/db/schema";
import { createUsageService, type UsageInput } from "../../src/server/usage/service";
import { usagePolicy, UsageError, reserveEstimate } from "../../src/server/usage/policy";
import { createChatHandler } from "../../src/server/chat-handler";
import { createChatStreamHandler } from "../../src/server/chat-stream-handler";
import { createSessionService } from "../../src/server/sessions";
import { createChatVoiceHandler } from "../../src/server/cloud-voice/chat-handler";

const designated = process.env.LAIN_USAGE_INTEGRATION_DATABASE, target = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/disabled");
if (!designated || !/^lain_usage_it_[a-f0-9]{16}$/.test(designated) || target.pathname !== `/${designated}` || !["localhost", "127.0.0.1"].includes(target.hostname)) throw Error("Refusing usage tests outside the designated disposable database.");
const settings = { NODE_ENV: "test", USAGE_TEXT_INPUT_USD_PER_MILLION: "1", USAGE_TEXT_OUTPUT_USD_PER_MILLION: "2", USAGE_DAILY_BUDGET_USD: "100", USAGE_TEXT_HOURLY_LIMIT: "100", USAGE_TEXT_DAILY_LIMIT: "100", USAGE_SPEECH_HOURLY_LIMIT: "100", USAGE_SPEECH_DAILY_LIMIT: "100", USAGE_SPEECH_MINUTE_LIMIT: "100", USAGE_GLOBAL_CONCURRENCY: "20", USAGE_SESSION_CONCURRENCY: "20" };
const request = new Request("http://localhost", { headers: { "x-vercel-forwarded-for": "203.0.113.7" } });
const policy = (extra: Record<string, string> = {}) => () => usagePolicy({ ...settings, ...extra });
const usage = (extra: Record<string, string> = {}) => createUsageService(getDatabase, policy(extra));
const input = (sessionId: string, extra: Partial<UsageInput> = {}): UsageInput => ({ request, sessionId, requestId: randomUUID(), kind: "text", model: "mock-priced", source: "Synthetic input", ...extra });
const http = (path: string, body: unknown, token: string, id = randomUUID()) => new NextRequest(`http://localhost${path}`, { method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json", Cookie: `lain_session=${token}`, "Idempotency-Key": id }, body: JSON.stringify(body) });

test("persistent usage accounting against disposable PostgreSQL", async t => {
  const db = getDatabase();
  const reset = async () => { await db.delete(usageReservations); await db.delete(usageUtterances); await db.delete(sessions); };
  const session = async () => (await db.insert(sessions).values({ tokenHash: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 3_600_000) }).returning())[0].id;
  try {
    await migrate(db, { migrationsFolder: "drizzle" });
    await t.test("ordinary application connections enforce query and lock timeouts", async () => {
      const timeout = await db.execute(sql`SHOW statement_timeout`), locks = await db.execute(sql`SHOW lock_timeout`);
      assert.equal(timeout.rows[0].statement_timeout, "5s"); assert.equal(locks.rows[0].lock_timeout, "3s");
      // Prove cancellation against PostgreSQL with a shorter fixture-only timeout.
      await assert.rejects(db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout = '20ms'`);
        await tx.execute(sql`SELECT pg_sleep(1)`);
      }));
      assert.equal((await db.execute(sql`SELECT 1 AS recovered`)).rows[0].recovered, 1);
    });
    await t.test("atomic reservations prevent concurrent quota and duplicate bypass", async () => {
      await reset(); const owner = await session(), service = usage({ USAGE_TEXT_HOURLY_LIMIT: "1" });
      const outcomes = await Promise.allSettled([service.reserve(input(owner)), service.reserve(input(owner))]);
      assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
      assert.ok(outcomes.some(item => item.status === "rejected" && item.reason instanceof UsageError && item.reason.code === "USAGE_HOURLY"));
      await reset(); const nextOwner = await session(), next = input(nextOwner), unrestricted = usage();
      const duplicates = await Promise.allSettled([unrestricted.reserve(next), unrestricted.reserve(next)]);
      assert.equal(duplicates.filter(item => item.status === "fulfilled").length, 1); assert.equal((await db.select().from(usageReservations)).length, 1);
      await assert.rejects(unrestricted.reserve({ ...next, source: "Conflicting" }), error => error instanceof UsageError && error.code === "USAGE_CONFLICT");
    });
    await t.test("hourly/daily quotas and UTC day boundary persist across service instances", async () => {
      await reset(); const owner = await session(), service = usage({ USAGE_TEXT_HOURLY_LIMIT: "1", USAGE_TEXT_DAILY_LIMIT: "1" });
      const first = await service.reserve(input(owner)); await first.finish();
      await assert.rejects(usage({ USAGE_TEXT_HOURLY_LIMIT: "1" }).reserve(input(owner)), error => error instanceof UsageError && error.retryAfter > 0);
      await db.update(usageReservations).set({ createdAt: new Date(Date.now() - 3_700_000) });
      // A fixture safely away from midnight verifies the daily check independently.
      await db.update(usageReservations).set({ createdAt: sql`date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'` });
      const later = usage({ USAGE_TEXT_HOURLY_LIMIT: "100", USAGE_TEXT_DAILY_LIMIT: "1" });
      await assert.rejects(later.reserve(input(owner)), error => error instanceof UsageError && error.code === "USAGE_DAILY");
    });
    await t.test("shared daily budget reserves maxima atomically then reconciles actual usage", async () => {
      await reset(); const owner = await session(), amount = reserveEstimate("text", "Synthetic input", policy()()).micro;
      const service = usage({ USAGE_DAILY_BUDGET_USD: String(amount / 1_000_000) });
      const contenders = await Promise.allSettled([service.reserve(input(owner)), usage({ USAGE_DAILY_BUDGET_USD: String(amount / 1_000_000) }).reserve(input(owner))]);
      assert.equal(contenders.filter(item => item.status === "fulfilled").length, 1);
      assert.ok(contenders.some(item => item.status === "rejected" && item.reason instanceof UsageError && item.reason.code === "USAGE_BUDGET"));
      const won = contenders.find(item => item.status === "fulfilled")!;
      assert.equal(won.status, "fulfilled"); if (won.status !== "fulfilled") throw Error("Missing reservation");
      const lease = won.value; await lease.start();
      await lease.finish({ input: 2, cached: 0, output: 3, audio: 0 });
      const [record] = await db.select().from(usageReservations); assert.equal(record.chargedMicro, 8); assert.equal(record.state, "settled");
      const smaller = await service.reserve({ ...input(owner), source: "x" }); await smaller.finish();
      assert.equal((await db.select().from(usageReservations)).length, 2);
    });
    await t.test("session/global concurrency is shared across text, speech and service instances", async () => {
      await reset(); const a = await session(), b = await session(), service = usage({ USAGE_SESSION_CONCURRENCY: "1", USAGE_GLOBAL_CONCURRENCY: "1" });
      const active = await service.reserve(input(a));
      await assert.rejects(service.reserve(input(a)), error => error instanceof UsageError && error.code === "USAGE_BUSY");
      await assert.rejects(usage({ USAGE_GLOBAL_CONCURRENCY: "1" }).reserve(input(b)), error => error instanceof UsageError && error.code === "USAGE_BUSY");
      await active.finish(); const next = await service.reserve(input(b)); await next.finish();
    });
    await t.test("unknown interrupted usage retains the maximum; dispatch cannot happen twice", async () => {
      await reset(); const owner = await session(), service = usage(), lease = await service.reserve(input(owner));
      await lease.start(); await assert.rejects(lease.start(), UsageError); await lease.finish(); await lease.finish({ input: 0, cached: 0, output: 0, audio: 0 });
      const [record] = await db.select().from(usageReservations); assert.equal(record.state, "uncertain"); assert.equal(record.chargedMicro, record.reservedMicro);
    });
    await t.test("expired leases free concurrency without erasing unknown spend; unstarted leases are safely voided", async () => {
      await reset(); const owner = await session(), service = usage({ USAGE_GLOBAL_CONCURRENCY: "1" });
      const first = await service.reserve(input(owner)); await first.start();
      await db.update(usageReservations).set({ leaseUntil: new Date(Date.now() - 1000) });
      const second = await service.reserve(input(owner)); await assert.rejects(first.start(), UsageError);
      await db.update(usageReservations).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(usageReservations.id, second.id));
      const third = await service.reserve(input(owner)); await third.finish();
      const [old] = await db.select().from(usageReservations).where(eq(usageReservations.id, first.id)); assert.equal(old.chargedMicro, old.reservedMicro);
      const [unused] = await db.select().from(usageReservations).where(eq(usageReservations.id, second.id)); assert.equal(unused.state, "voided"); assert.equal(unused.chargedMicro, 0);
    });
    await t.test("trusted IP limits survive session rotation and deletion without retaining raw IPs", async () => {
      await reset(); const a = await session(), service = usage({ USAGE_TRUSTED_PROXY: "vercel", VERCEL: "1", USAGE_IP_HMAC_KEY: "test-secret-with-at-least-32-characters", USAGE_IP_MINUTE_LIMIT: "1" });
      const lease = await service.reserve(input(a)); await lease.start(); await lease.finish(); await db.delete(sessions).where(eq(sessions.id, a));
      const b = await session(); await assert.rejects(service.reserve(input(b)), error => error instanceof UsageError && error.code === "USAGE_IP_LIMIT");
      const [row] = await db.select().from(usageReservations); assert.equal(row.sessionId, null); assert.match(row.ipHash!, /^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(row).includes("203.0.113.7"));
    });
    await t.test("progressive speech budgets, indices, and every segment are persistent", async () => {
      await reset(); const owner = await session(), service = usage({ USAGE_SPEECH_MINUTE_LIMIT: "2" }), requestId = randomUUID();
      const part = (index: number, chars: number) => input(owner, { kind: "speech", requestId, segment: { index, chars, final: false, progressive: true } });
      const first = await service.reserve(part(0, 400)); await first.start(); await first.finish(undefined, { completed: true, generationMs: 1000, audioBytes: 48000 });
      const second = await usage({ USAGE_SPEECH_MINUTE_LIMIT: "2" }).reserve(part(1, 399)); assert.equal(second.generationMs, 1000); assert.equal(second.audioBytes, 48000); await second.start(); await second.finish(undefined, { completed: true, generationMs: 1000, audioBytes: 48000 });
      await assert.rejects(service.reserve(part(2, 1)), UsageError); assert.equal((await db.select().from(usageReservations)).length, 2);
      await reset(); const nextOwner = await session(), id = randomUUID(); const reservation = await usage().reserve(input(nextOwner, { kind: "speech", requestId: id, segment: { index: 0, chars: 790, final: false, progressive: true } }));
      await reservation.start(); await reservation.finish(undefined, { completed: true, generationMs: 30000, audioBytes: 2_880_000 });
      await assert.rejects(usage().reserve(input(nextOwner, { kind: "speech", requestId: id, segment: { index: 1, chars: 10, final: true, progressive: true } })), UsageError);
    });
    await t.test("text endpoints require sessions/IDs and never duplicate mock billable dispatch", async () => {
      await reset(); const identity = await createSessionService().getOrCreateSession(undefined), token = identity.newToken!; let calls = 0;
      const handler = createChatHandler({ usage: usage(), getAdapter: () => ({ billing: { model: "mock-priced" }, async generate(_messages, _signal, report) { calls++; report?.({ input: 10, cached: 0, output: 4, audio: 0 }); return "Mock reply"; } }) });
      const id = randomUUID(), body = { messages: [{ role: "user", content: "Hello" }] };
      assert.equal((await handler(http("/api/chat", body, token, id))).status, 200); assert.equal((await handler(http("/api/chat", body, token, id))).status, 409); assert.equal(calls, 1);
      assert.equal((await handler(http("/api/chat", body, "invalid"))).status, 401);
    });
    await t.test("persisted text quota rejection rolls back the claim; retry and completed replay remain safe", async () => {
      await reset(); const identity = await createSessionService().getOrCreateSession(undefined), token = identity.newToken!, requestId = randomUUID(); let calls = 0;
      const getAdapter = () => ({ billing: { model: "mock-priced" }, async *stream(_messages: unknown, _signal: AbortSignal, report?: (value: { input: number; cached: number; output: number; audio: number }) => void) { calls++; yield "Mock reply"; report?.({ input: 10, cached: 0, output: 4, audio: 0 }); } });
      const body = { mode: "persisted", requestId, messages: [{ role: "user", content: "Hello" }] };
      const blocked = await createChatStreamHandler({ usage: usage({ USAGE_TEXT_HOURLY_LIMIT: "0" }), getAdapter })(http("/api/chat/stream", body, token));
      assert.equal(blocked.status, 429); assert.ok(blocked.headers.has("Retry-After")); assert.equal((await db.select().from(conversations)).length, 0); assert.equal((await db.select().from(messages)).length, 0);
      const handler = createChatStreamHandler({ usage: usage(), getAdapter });
      const first = await handler(http("/api/chat/stream", body, token)); assert.match(await first.text(), /event: done/);
      const replay = await handler(http("/api/chat/stream", body, token)); assert.match(await replay.text(), /"replayed":true/); assert.equal(calls, 1); assert.equal((await db.select().from(usageReservations)).length, 1);
    });
    await t.test("voice session accounting runs before relay and retains the approved narration", async () => {
      await reset(); const identity = await createSessionService().getOrCreateSession(undefined), token = identity.newToken!; let calls = 0;
      const handler = createChatVoiceHandler({ development: () => true, usage: usage(), relay: async (req, limits) => {
        calls++; const body = await req.json(); assert.equal(body.voice, "shimmer"); assert.ok(body.delivery.includes("Vocal Identity v2.0"));
        await limits.usageLease!.start(); await limits.usageLease!.finish({ input: 20, cached: 0, output: 5, audio: 30 }, { completed: true, generationMs: 1, audioBytes: 4800 }); return new Response("mock");
      } });
      const body = { requestId: randomUUID(), text: "A thought.", segment: { index: 0, final: true } };
      assert.equal(await (await handler(http("/api/voice", body, token))).text(), "mock"); assert.equal((await handler(http("/api/voice", body, token))).status, 409); assert.equal(calls, 1);
    });
    await t.test("cancelled text keeps the reservation when final usage is unavailable", async () => {
      await reset(); const identity = await createSessionService().getOrCreateSession(undefined), token = identity.newToken!;
      const handler = createChatStreamHandler({ usage: usage(), getAdapter: () => ({ billing: { model: "mock-priced" }, async *stream(_messages, signal) { yield "Partial"; await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); } }) });
      const response = await handler(http("/api/chat/stream", { messages: [{ role: "user", content: "Hello" }] }, token)), reader = response.body!.getReader(); await reader.read(); await reader.cancel(); await delay(5);
      const [row] = await db.select().from(usageReservations); assert.equal(row.state, "uncertain"); assert.equal(row.chargedMicro, row.reservedMicro);
    });
    await t.test("schema uniqueness and nonnegative accounting constraints hold in PostgreSQL", async () => {
      const [row] = await db.select().from(usageReservations); let rejected = false;
      try { await db.insert(usageReservations).values({ ...row, id: randomUUID() }); } catch { rejected = true; } assert.ok(rejected);
      await assert.rejects(db.update(usageReservations).set({ chargedMicro: -1 }).where(eq(usageReservations.id, row.id)));
    });
  } finally { await db.$client.end(); }
});
