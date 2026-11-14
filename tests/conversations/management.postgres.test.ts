import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
import { getDatabase } from "../../src/server/db";
import { conversations, messages, sessions, streamRequests } from "../../src/server/db/schema";
import { createSessionService, sessionCookieSettings } from "../../src/server/sessions";
import { createConversationRepository } from "../../src/server/conversations/repository";
import { createConversationHandlers } from "../../src/server/conversations/handler";
import { automaticConversationTitle } from "../../src/server/conversations/title";
import { createStreamPersistence } from "../../src/server/stream-persistence";
import { createChatStreamHandler } from "../../src/server/chat-stream-handler";
import type { PersistedStreamInput } from "../../src/server/persisted-stream-request";

const designated = process.env.LAIN_MANAGEMENT_INTEGRATION_DATABASE;
const target = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/disabled");
if (!designated || !/^lain_management_it_[a-f0-9]{16}$/.test(designated) || target.pathname !== `/${designated}` ||
    !["localhost", "127.0.0.1"].includes(target.hostname)) throw new Error("Refusing tests outside the designated disposable database.");
async function check(t: TestContext, name: string, fn: () => Promise<void>) {
  await t.test(name, async () => { try { await fn(); } catch { assert.fail(`${name}: check failed; private details withheld.`); } });
}
function request(id: string, token: string, method = "DELETE", body?: object) {
  return new NextRequest(`http://localhost/api/conversations/${id}`, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { Origin: "http://localhost", "Content-Type": "application/json", Cookie: `${sessionCookieSettings().name}=${token}` } });
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
function input(conversationId?: string): PersistedStreamInput { return { mode: "persisted", requestId: randomUUID(), conversationId, messages: [{ role: "user", content: "Automatic persisted streaming title" }] }; }

test("PostgreSQL conversation management", { timeout: 25000 }, async t => {
  const db = getDatabase(), repo = createConversationRepository(), handlers = createConversationHandlers(), persistence = createStreamPersistence();
  try {
    await migrate(db, { migrationsFolder: "drizzle" });
    const service = createSessionService(), first = await service.getOrCreateSession(undefined), second = await service.getOrCreateSession(undefined);
    const owner = first.session.id, token = first.newToken!, other = second.newToken!;
    const currentTitle = async (id: string) => (await db.select().from(conversations).where(eq(conversations.id, id)))[0]?.title;
    const present = async (id: string) => ({
      conversations: (await db.select().from(conversations).where(eq(conversations.id, id))).length,
      messages: (await db.select().from(messages).where(eq(messages.conversationId, id))).length,
      requests: (await db.select().from(streamRequests).where(eq(streamRequests.conversationId, id))).length,
    });
    await check(t, "first persisted user message sets a deterministic title and later messages preserve it", async () => {
      const conversation = (await repo.create(owner))!;
      const content = "  A calm\n first thought with enough words to make a sensible shortened conversation title for history  ";
      await repo.appendMessage(owner, conversation.id, { role: "user", content });
      assert.ok(await currentTitle(conversation.id) === automaticConversationTitle(content));
      await repo.appendMessage(owner, conversation.id, { role: "user", content: "A later thought" });
      assert.ok(await currentTitle(conversation.id) === automaticConversationTitle(content));
      const historical = (await repo.create(owner))!;
      await db.insert(messages).values({ conversationId: historical.id, role: "user", content: "Previously persisted first message", createdAt: new Date(0) });
      await repo.appendMessage(owner, historical.id, { role: "user", content: "New message" });
      assert.ok(await currentTitle(historical.id) === "Previously persisted first message");
    });
    await check(t, "manually created/renamed titles win, including concurrent append and rename", async () => {
      const manual = (await repo.create(owner, { title: "Existing manual title" }))!;
      await repo.appendMessage(owner, manual.id, { role: "user", content: "Do not overwrite" });
      assert.ok(await currentTitle(manual.id) === "Existing manual title");
      const renamed = await handlers.rename(request(manual.id, token, "PATCH", { title: " Renamed manually " }), context(manual.id));
      assert.ok(renamed.status === 200 && (await renamed.json()).conversation.title === "Renamed manually");
      await repo.appendMessage(owner, manual.id, { role: "user", content: "Still preserve" });
      assert.ok(await currentTitle(manual.id) === "Renamed manually");
      const concurrent = (await repo.create(owner))!;
      await Promise.all([repo.appendMessage(owner, concurrent.id, { role: "user", content: "Concurrent first thought" }), repo.rename(owner, concurrent.id, { title: "Manual wins" })]);
      assert.ok(await currentTitle(concurrent.id) === "Manual wins");
    });
    await check(t, "cross-session rename/delete and missing IDs return uniform 404 without mutation", async () => {
      const conversation = (await repo.create(owner, { title: "Private title" }))!;
      await repo.appendMessage(owner, conversation.id, { role: "user", content: "Private message" });
      for (const method of ["PATCH", "DELETE"]) {
        const foreign = method === "PATCH" ? await handlers.rename(request(conversation.id, other, method, { title: "Blocked" }), context(conversation.id))
          : await handlers.remove(request(conversation.id, other), context(conversation.id));
        const missingId = randomUUID();
        const missing = method === "PATCH" ? await handlers.rename(request(missingId, other, method, { title: "Blocked" }), context(missingId))
          : await handlers.remove(request(missingId, other), context(missingId));
        assert.ok(foreign.status === 404 && JSON.stringify(await foreign.json()) === JSON.stringify(await missing.json()));
      }
      assert.ok(await currentTitle(conversation.id) === "Private title" && (await present(conversation.id)).messages === 1);
    });
    await check(t, "deletion cascades messages and idempotency records while preserving sessions and unrelated data", async () => {
      const receipt = await persistence.begin(owner, input());
      const unrelated = (await repo.create(owner, { title: "Keep me" }))!;
      const before = await present(receipt.conversationId); assert.ok(before.messages === 2 && before.requests === 1);
      const response = await handlers.remove(request(receipt.conversationId, token), context(receipt.conversationId));
      assert.ok(response.status === 200 && (await response.json()).deletedId === receipt.conversationId);
      assert.ok(JSON.stringify(await present(receipt.conversationId)) === JSON.stringify({ conversations: 0, messages: 0, requests: 0 }));
      assert.ok((await db.select().from(sessions).where(eq(sessions.id, owner))).length === 1 && (await present(unrelated.id)).conversations === 1);
      let rejected = false; try { await persistence.finish(receipt, "Late finalization", "completed"); } catch { rejected = true; }
      assert.ok(rejected && (await present(receipt.conversationId)).conversations === 0);
      assert.ok(await repo.appendMessage(owner, receipt.conversationId, { role: "user", content: "Late append" }) === null);
    });
    await check(t, "deleting during generation prevents late stream completion from saving or recreating records", async () => {
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      const streaming = createChatStreamHandler({ getAdapter: () => ({ async *stream() { yield "Partial"; await gate; yield " remainder"; } }) });
      const body = input();
      const response = await streaming(new Request("http://localhost/api/chat/stream", { method: "POST",
        headers: { Origin: "http://localhost", "Content-Type": "application/json", Cookie: `${sessionCookieSettings().name}=${token}` }, body: JSON.stringify(body) }));
      const reader = response.body!.getReader(), decoder = new TextDecoder();
      const metadata = JSON.parse(decoder.decode((await reader.read()).value).split("data: ")[1].trim());
      await reader.read();
      const removed = await handlers.remove(request(metadata.conversationId, token), context(metadata.conversationId)); assert.ok(removed.status === 200);
      release(); let wire = "";
      for (;;) { const part = await reader.read(); if (part.done) break; wire += decoder.decode(part.value); }
      assert.ok(!wire.includes("event: done") && wire.includes("event: error"));
      assert.ok((await present(metadata.conversationId)).conversations === 0 && (await present(metadata.conversationId)).messages === 0);
    });
    await check(t, "concurrent finalization/deletion serializes safely and the deleted conversation stays gone", async () => {
      const receipt = await persistence.begin(owner, input());
      const results = await Promise.allSettled([persistence.finish(receipt, "Complete just before deletion", "completed"), repo.remove(owner, receipt.conversationId)]);
      assert.ok(results[1].status === "fulfilled" && results[1].value?.id === receipt.conversationId);
      assert.ok((await present(receipt.conversationId)).conversations === 0 && (await present(receipt.conversationId)).requests === 0);
    });
    await check(t, "database mutation failures return safe errors without deleting data", async () => {
      const conversation = (await repo.create(owner))!;
      await db.execute(sql`CREATE FUNCTION reject_management_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_FAILURE'; END $$`);
      await db.execute(sql`CREATE TRIGGER reject_management_delete BEFORE DELETE ON conversations FOR EACH ROW EXECUTE FUNCTION reject_management_delete()`);
      try { const failed = await handlers.remove(request(conversation.id, token), context(conversation.id));
        assert.ok(failed.status === 503 && (await failed.json()).error.code === "STORAGE_UNAVAILABLE");
        assert.ok((await present(conversation.id)).conversations === 1);
      } finally { await db.execute(sql`DROP TRIGGER reject_management_delete ON conversations`); await db.execute(sql`DROP FUNCTION reject_management_delete()`); }
    });
  } catch { assert.fail("Conversation management PostgreSQL setup failed; private details withheld."); }
  finally { await db.$client.end(); }
});
