import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
import { getDatabase } from "../../src/server/db";
import { conversations, messages, sessions } from "../../src/server/db/schema";
import { createSessionService, sessionCookieSettings } from "../../src/server/sessions";
import { createConversationRepository } from "../../src/server/conversations/repository";
import { createConversationHandlers } from "../../src/server/conversations/handler";

const designated = process.env.LAIN_CONVERSATION_INTEGRATION_DATABASE;
const target = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/disabled");
if (!designated || !/^lain_conversation_it_[a-f0-9]{16}$/.test(designated) ||
    target.pathname !== `/${designated}` || !["localhost", "127.0.0.1"].includes(target.hostname)) {
  throw new Error("Refusing conversation tests outside the designated disposable database.");
}
async function check(t: TestContext, name: string, fn: () => Promise<void>) {
  await t.test(name, async () => { try { await fn(); } catch { assert.fail(`${name}: check failed; private details withheld.`); } });
}
function request(token?: string, method = "GET", query = "", body?: string) {
  return new NextRequest(`http://localhost/api/conversations${query}`, { method, body,
    headers: { Origin: "http://localhost", "Content-Type": "application/json", ...(token ? { Cookie: `${sessionCookieSettings().name}=${token}` } : {}) } });
}

test("PostgreSQL conversation ownership and storage", { timeout: 20_000 }, async t => {
  const db = getDatabase(), repo = createConversationRepository(), service = createSessionService();
  const handlers = createConversationHandlers();
  try {
    await migrate(db, { migrationsFolder: "drizzle" });
    const first = await service.getOrCreateSession(undefined), second = await service.getOrCreateSession(undefined);
    const a = first.session.id, b = second.session.id;
    let own = "", foreign = "", foreignMessage = "", messageId = "";
    await check(t, "creates conversations with database-enforced owners and safe HTTP metadata", async () => {
      const response = await handlers.create(request(first.newToken, "POST", "", '{"title":"First"}'));
      assert.ok(response.status === 201);
      const body = await response.json(); own = body.conversation.id;
      assert.ok(body.conversation.title === "First" && body.conversation.sessionId === undefined);
      const [row] = await db.select().from(conversations).where(eq(conversations.id, own));
      assert.ok(row.sessionId === a);
      foreign = (await repo.create(b, { title: "Other owner" }))!.id;
      foreignMessage = (await repo.appendMessage(b, foreign, { role: "assistant", content: "Other session text" }))!.id;
    });
    await check(t, "lists only owned conversations newest first with deterministic ties and bounded pages", async () => {
      const next = (await repo.create(a, { title: "Next" }))!, tied = (await repo.create(a))!;
      const earlier = new Date("2026-01-01T00:00:00Z"), later = new Date("2026-01-02T00:00:00Z");
      await db.update(conversations).set({ createdAt: earlier }).where(eq(conversations.id, own));
      await db.update(conversations).set({ createdAt: later }).where(inArray(conversations.id, [next.id, tied.id]));
      const expected = [next.id, tied.id].sort().reverse();
      const page = await repo.list(a, { limit: 2, offset: 0 });
      assert.ok(JSON.stringify(page.items.map(x => x.id)) === JSON.stringify(expected));
      assert.ok(page.pagination.nextOffset === 2);
      const tail = await repo.list(a, { limit: 2, offset: 2 });
      assert.ok(tail.items.length === 1 && tail.items[0].id === own && tail.pagination.nextOffset === null);
      assert.ok((await repo.list(b)).items.every(x => x.id === foreign));
      assert.ok((await repo.list(a, { limit: 50, offset: 10000 })).items.length === 0);
    });
    await check(t, "appends messages atomically and retrieves chronological pages with UUID tie-breakers", async () => {
      const one = (await repo.appendMessage(a, own, { role: "user", content: "First question" }))!;
      const two = (await repo.appendMessage(a, own, { role: "assistant", content: "Partial response", status: "interrupted" }))!;
      const three = (await repo.appendMessage(a, own, { role: "user", content: "Next question" }))!;
      messageId = two.id;
      await db.update(messages).set({ createdAt: new Date("2026-01-01T00:00:00Z") }).where(eq(messages.id, one.id));
      await db.update(messages).set({ createdAt: new Date("2026-01-02T00:00:00Z") }).where(inArray(messages.id, [two.id, three.id]));
      const expected = [one.id, ...[two.id, three.id].sort()];
      const head = (await repo.get(a, own, { limit: 2, offset: 0 }))!;
      const tail = (await repo.get(a, own, { limit: 2, offset: 2 }))!;
      assert.ok(JSON.stringify([...head.messages, ...tail.messages].map(x => x.id)) === JSON.stringify(expected));
      assert.ok(head.pagination.nextOffset === 2 && tail.pagination.nextOffset === null);
    });
    await check(t, "updates only message content/status and advances conversation updated_at", async () => {
      const before = (await repo.get(a, own))!.conversation.updatedAt;
      const updated = await repo.updateMessage(a, own, messageId, { content: " Complete response ", status: "completed" });
      assert.ok(updated?.content === " Complete response " && updated.status === "completed" && updated.role === "assistant");
      assert.ok((await repo.get(a, own))!.conversation.updatedAt.getTime() >= before.getTime());
      assert.ok((await repo.updateMessage(a, own, messageId, { status: "failed" }))?.status === "failed");
      assert.ok(await repo.updateMessage(a, own, randomUUID(), { status: "failed" }) === null);
    });
    await check(t, "known foreign UUIDs cannot be read, appended to or updated, with uniform HTTP 404", async () => {
      const before = await db.select().from(messages).where(eq(messages.id, foreignMessage));
      assert.ok(await repo.get(a, foreign) === null);
      assert.ok(await repo.appendMessage(a, foreign, { role: "user", content: "Blocked" }) === null);
      assert.ok(await repo.updateMessage(a, foreign, foreignMessage, { content: "Blocked" }) === null);
      assert.ok(await repo.updateMessage(a, own, foreignMessage, { status: "failed" }) === null);
      assert.ok(JSON.stringify(await db.select().from(messages).where(eq(messages.id, foreignMessage))) === JSON.stringify(before));
      const context = (id: string) => ({ params: Promise.resolve({ id }) });
      const forbidden = await handlers.get(request(first.newToken), context(foreign));
      const missing = await handlers.get(request(first.newToken), context(randomUUID()));
      assert.ok(forbidden.status === 404 && missing.status === 404);
      assert.ok(JSON.stringify(await forbidden.json()) === JSON.stringify(await missing.json()));
    });
    await check(t, "missing, invalid and expired cookie sessions cannot access storage or create sessions", async () => {
      const expired = await service.getOrCreateSession(undefined);
      await db.update(sessions).set({ expiresAt: new Date(0) }).where(eq(sessions.id, expired.session.id));
      const before = await db.select({ count: sql<number>`count(*)::int` }).from(sessions);
      for (const token of [undefined, "invalid", expired.newToken]) {
        assert.ok((await handlers.list(request(token))).status === 401);
        assert.ok((await handlers.create(request(token, "POST", "", "{}"))).status === 401);
      }
      const after = await db.select({ count: sql<number>`count(*)::int` }).from(sessions);
      assert.ok(before[0].count === after[0].count);
      assert.ok(await repo.create(expired.session.id) === null);
    });
    await check(t, "HTTP retrieval and listing pass pagination through the real repository", async () => {
      const result = await handlers.get(request(first.newToken, "GET", "?limit=1&offset=1"), { params: Promise.resolve({ id: own }) });
      const body = await result.json();
      assert.ok(result.status === 200 && body.messages.length === 1 && body.pagination.offset === 1);
      assert.ok(result.headers.get("set-cookie") === null);
      const listed = await handlers.list(request(first.newToken, "GET", "?limit=1"));
      assert.ok(listed.status === 200 && (await listed.json()).conversations.length === 1);
    });
  } catch { assert.fail("Conversation PostgreSQL setup failed; private details withheld."); }
  finally { await db.$client.end(); }
});
