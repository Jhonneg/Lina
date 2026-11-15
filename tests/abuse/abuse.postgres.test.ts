import assert from "node:assert/strict";
import { createStagingAccessHandlers } from "../../src/server/staging-access/handler";
import { withNetlifyIp } from "../netlify/context";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
import { getDatabase } from "../../src/server/db";
import { sessions, conversations, apiRateBuckets, usageReservations } from "../../src/server/db/schema";
import { createApiGuard } from "../../src/server/abuse/guard";
import { abusePolicy } from "../../src/server/abuse/policy";
import { cleanupExpiredSessions } from "../../src/server/abuse/cleanup";
import { createConversationRepository } from "../../src/server/conversations/repository";
import { createStreamPersistence } from "../../src/server/stream-persistence";
import { createSessionHandler } from "../../src/server/session-handler";
import { createSessionService } from "../../src/server/sessions";
import { UsageError } from "../../src/server/usage/policy";
const designated = process.env.LAIN_ABUSE_INTEGRATION_DATABASE, target = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/disabled");
if (!designated || !/^lain_abuse_it_[a-f0-9]{16}$/.test(designated) || target.pathname !== `/${designated}` || !["127.0.0.1", "localhost"].includes(target.hostname)) throw Error("Refusing tests outside designated disposable database.");
const defaults = { NODE_ENV: "test", VERCEL: "1", USAGE_TRUSTED_PROXY: "vercel", USAGE_IP_HMAC_KEY: "test-only-key-with-at-least-32-characters" };
const policy = (extra: Record<string, string> = {}) => () => abusePolicy({ ...defaults, ...extra });
const req = (ip = "203.0.113.8", cookie = "") => new NextRequest("http://localhost/api/session", { method: "POST", headers: { Origin: "http://localhost", "x-vercel-forwarded-for": ip, Cookie: `lain_session=${cookie}` } });
async function withEnv(values: Record<string, string>, work: () => Promise<void>) {
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  try { await work(); } finally { for (const key of Object.keys(values)) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } }
}
test("API admission, storage and explicit retention against disposable PostgreSQL", async t => {
  const db = getDatabase(), repository = createConversationRepository(), service = createSessionService();
  const owner = async () => (await service.getOrCreateSession(undefined)).session.id;
  try {
    await migrate(db, { migrationsFolder: "drizzle" });
    await t.test("staging login limits persist across handlers and cookie rotation before credential acceptance", async () => {
      const fixtureSecret = randomUUID().replaceAll("-", "").repeat(2);
      await withEnv({ STAGING_ACCESS_MODE: "restricted", STAGING_ACCESS_SECRET: fixtureSecret }, async () => {
        const factory = policy({ API_ACCESS_IP_MINUTE: "2" });
        const handlers = [createStagingAccessHandlers({ abuse: createApiGuard(getDatabase, factory) }), createStagingAccessHandlers({ abuse: createApiGuard(getDatabase, factory) })];
        const attempt = (secret: string, cookie = "") => new NextRequest("http://localhost/api/staging-access", { method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json", "x-vercel-forwarded-for": "203.0.113.211", Cookie: `lain_session=${cookie}` }, body: JSON.stringify({ secret }) });
        assert.equal((await handlers[0].POST(attempt("wrong"))).status, 401);
        assert.equal((await handlers[1].POST(attempt("wrong", "rotated"))).status, 401);
        const response = await handlers[0].POST(attempt(fixtureSecret));
        assert.equal(response.status, 429); assert.ok(response.headers.has("Retry-After")); assert.ok(!response.headers.has("Set-Cookie"));
      });
      await db.delete(apiRateBuckets); // This runner is guarded to its own newly created disposable DB.
    });
    await t.test("Netlify authoritative IP protects non-billable session creation across cookie rotation", async () => {
      const factory = policy({ USAGE_TRUSTED_PROXY: "netlify", API_SESSION_IP_DAY: "1" });
      const guard = createApiGuard(getDatabase, factory);
      await assert.rejects(guard.take(req(), "session"), UsageError);
      await withNetlifyIp("203.0.113.219", async () => {
        await guard.take(req("192.0.2.1"), "session");
        await assert.rejects(guard.take(req("192.0.2.2", "invalid"), "session"), e => e instanceof UsageError && e.status === 429);
      });
      // Isolate fixtures for the pre-existing accounting assertions below.
      await db.delete(apiRateBuckets);
    });
    await t.test("IP counters prevent concurrent creation and survive rotation/restarts/spoofed forwarded headers", async () => {
      const factory = policy({ API_SESSION_IP_DAY: "1" }), handler = createSessionHandler({ abuse: createApiGuard(getDatabase, factory) });
      const attempts = await Promise.all([handler(req()), handler(req())]); assert.deepEqual(attempts.map(r => r.status).sort(), [200, 429]);
      const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(sessions); assert.equal(count.n, 1);
      const rotated = req("203.0.113.8", "invalid"); rotated.headers.set("x-forwarded-for", "198.51.100.5");
      const again = await createSessionHandler({ abuse: createApiGuard(getDatabase, factory) })(rotated); assert.equal(again.status, 429); assert.ok(again.headers.has("Retry-After"));
      assert.equal((await db.select({ n: sql<number>`count(*)::int` }).from(sessions))[0].n, 1);
      await assert.rejects(createApiGuard(getDatabase, factory).take(req("not-an-ip"), "session"), UsageError);
      assert.equal((await db.select().from(apiRateBuckets)).length, 4); // Two IP plus two verified-session counters, not attempts.
    });
    await t.test("verified-session quota spans IPs, categories stay independent, counters roll into new windows", async () => {
      const id = await owner(), guard = createApiGuard(getDatabase, policy({ API_READ_SESSION_MINUTE: "1" }));
      await guard.take(req("203.0.113.10"), "read", id);
      await assert.rejects(guard.take(req("203.0.113.11"), "read", id), error => error instanceof UsageError && error.status === 429);
      await guard.take(req(), "mutate", id);
      // A prior-window fixture must not affect admission in the current minute/day.
      await db.insert(apiRateBuckets).values({ key: `read:s:${id}:m:0`, count: 100000, expiresAt: new Date(0) });
      const other = await owner(); await guard.take(req(), "read", other);
    });
    await t.test("concurrent conversation/message inserts respect per-session caps without deleting data", async () => {
      const id = await owner();
      await withEnv({ STORAGE_CONVERSATIONS_PER_SESSION: "1", STORAGE_MESSAGES_PER_SESSION: "1" }, async () => {
        const creates = await Promise.allSettled([repository.create(id), repository.create(id)]); assert.equal(creates.filter(x => x.status === "fulfilled").length, 1);
        const [conversation] = await db.select().from(conversations).where(eq(conversations.sessionId, id));
        const appends = await Promise.allSettled([repository.appendMessage(id, conversation.id, { role: "user", content: "One" }), repository.appendMessage(id, conversation.id, { role: "user", content: "Two" })]);
        assert.equal(appends.filter(x => x.status === "fulfilled").length, 1);
        assert.equal((await repository.get(id, conversation.id))!.messages.length, 1);
        const stranger = await owner(); assert.equal(await repository.appendMessage(stranger, conversation.id, { role: "user", content: "Foreign" }), null);
      });
    });
    await t.test("stream claims reserve both message slots atomically and existing replay works at the cap", async () => {
      const id = await owner(), persistence = createStreamPersistence(), input = { mode: "persisted" as const, conversationId: undefined as string | undefined, requestId: randomUUID(), messages: [{ role: "user" as const, content: "A thought" }] };
      await withEnv({ STORAGE_MESSAGES_PER_SESSION: "3" }, async () => {
        const first = await persistence.begin(id, input); await persistence.finish(first, "A reply", "completed");
        await assert.rejects(persistence.begin(id, { ...input, requestId: randomUUID(), conversationId: first.conversationId }), error => error instanceof UsageError && error.code === "STORAGE_LIMIT");
        assert.equal((await persistence.begin(id, input)).isNew, false);
        assert.equal((await repository.get(id, first.conversationId))!.messages.length, 2);
      });
    });
    await t.test("cleanup defaults to dry-run, processes bounded expired data, preserves active/grace data and billing records", async () => {
      const old = await owner(), active = await owner(), grace = await owner();
      const conversation = (await repository.create(old))!;
      await repository.appendMessage(old, conversation.id, { role: "user", content: "Disposable expired fixture" });
      await repository.appendMessage(old, conversation.id, { role: "assistant", content: "Disposable reply" });
      await db.update(sessions).set({ expiresAt: new Date(Date.now() - 8 * 86400000) }).where(eq(sessions.id, old));
      await db.update(sessions).set({ expiresAt: new Date(Date.now() - 3 * 86400000) }).where(eq(sessions.id, grace));
      const [ledger] = await db.insert(usageReservations).values({ sessionId: old, requestId: randomUUID(), kind: "text", fingerprint: "fixture", model: "mock", pricing: { input: 1, cached: 0, output: 2, audio: 0 }, reservedMicro: 3, chargedMicro: 3, leaseUntil: new Date(0) }).returning();
      const factory = policy({ API_CLEANUP_BATCH: "2" });
      assert.equal((await cleanupExpiredSessions({}, getDatabase, factory)).dryRun, true);
      assert.equal((await repository.get(old, conversation.id))!.messages.length, 2);
      for (let i = 0; i < 10; i++) {
        const result = await cleanupExpiredSessions({ apply: true }, getDatabase, factory);
        if (!result.dryRun && result.removed) assert.ok(Object.values(result.removed).reduce((a, b) => a + b, 0) <= 2);
      }
      assert.equal((await db.select().from(sessions).where(eq(sessions.id, old))).length, 0);
      assert.equal((await db.select().from(sessions).where(eq(sessions.id, active))).length, 1); assert.equal((await db.select().from(sessions).where(eq(sessions.id, grace))).length, 1);
      const [kept] = await db.select().from(usageReservations).where(eq(usageReservations.id, ledger.id)); assert.equal(kept.sessionId, null); assert.equal(kept.chargedMicro, 3);
    });
    await t.test("accounting errors fail closed before handlers can create sessions", async () => {
      const guard = createApiGuard(() => { throw Error("PRIVATE"); }, policy());
      assert.equal((await createSessionHandler({ abuse: guard })(req("198.51.100.10"))).status, 503);
    });
  } finally { await db.$client.end(); }
});
