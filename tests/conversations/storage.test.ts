import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { createConversationHandlers } from "../../src/server/conversations/handler";
import { createConversationRepository } from "../../src/server/conversations/repository";
import { identifier, messageInput, messagePatch, queryPage, STORAGE_LIMITS, StorageInputError, titleInput } from "../../src/server/conversations/validation";
import { createSessionService, sessionCookieSettings } from "../../src/server/sessions";

const owner = randomUUID(), conversationId = randomUUID(), token = "a".repeat(64);
const expiresAt = new Date(Date.now() + 86400000);
const conversation = { id: conversationId, title: null, createdAt: new Date(), updatedAt: new Date() };
function fixture(failing = false) {
  let calls = 0, inserts = 0;
  const service = createSessionService({
    async findByHash(hash) {
      if (hash === createHash("sha256").update(token).digest("hex")) return { id: owner, expiresAt };
      if (hash === createHash("sha256").update("c".repeat(64)).digest("hex")) return { id: owner, expiresAt: new Date(0) };
      return null;
    },
    async insert() { inserts++; throw new Error("Unexpected session creation"); },
  });
  function called(id: string) { assert.equal(id, owner); calls++; if (failing) throw new Error("DO_NOT_LEAK content credentials"); }
  const handlers = createConversationHandlers({ service, repository: {
    async create(id, input) { called(id); return { ...conversation, title: titleInput(input) }; },
    async list(id, page = { limit: 20, offset: 0 }) { called(id); return { items: [conversation], pagination: { ...page, nextOffset: null } }; },
    async get(id, target, page = { limit: 20, offset: 0 }) { called(id); return target === conversationId
      ? { conversation, messages: [], pagination: { ...page, nextOffset: null } } : null; },
  } });
  return { handlers, counts: () => ({ calls, inserts }) };
}
function request(method = "GET", cookie: string | null = token, query = "", body?: string, headers = {}) {
  return new NextRequest(`http://localhost/api/conversations${query}`, { method,
    headers: { Origin: "http://localhost", "Content-Type": "application/json", ...(cookie ? { Cookie: `${sessionCookieSettings().name}=${cookie}` } : {}), ...headers }, body });
}
const context = (id: string = conversationId) => ({ params: Promise.resolve({ id }) });

test("storage validates UUIDs, bounded pagination and strict query fields", () => {
  assert.equal(identifier(owner.toUpperCase()), owner);
  assert.deepEqual(queryPage(new URLSearchParams()), { limit: 20, offset: 0 });
  assert.deepEqual(queryPage(new URLSearchParams("limit=50&offset=10000")), { limit: 50, offset: 10000 });
  for (const query of ["limit=0", "limit=51", "limit=-1", "limit=1.5", "limit=1e1", "offset=10001", "offset=-1", "limit=", "limit=1&limit=2", "sessionId=x", "cursor=x"]) {
    assert.throws(() => queryPage(new URLSearchParams(query)), StorageInputError);
  }
  for (const id of [null, "invalid", "' OR true", "a".repeat(100)]) assert.throws(() => identifier(id), StorageInputError);
});

test("title, role, content and patch validation preserve allowed values and reject extra fields", () => {
  assert.equal(titleInput({ title: "a".repeat(200) })?.length, 200);
  assert.equal(titleInput({}), null);
  assert.equal(messageInput({ role: "assistant", content: " a ", status: "interrupted" }).content, " a ");
  assert.equal(messageInput({ role: "user", content: "a".repeat(16000) }).status, "completed");
  assert.deepEqual(messagePatch({ status: "failed" }), { status: "failed" });
  for (const value of [null, [], { title: " " }, { title: 2 }, { title: "a".repeat(201) }, { sessionId: owner }]) assert.throws(() => titleInput(value), StorageInputError);
  for (const value of [{ role: "system", content: "x" }, { role: "developer", content: "x" }, { role: "user", content: " " },
    { role: "user", content: "x".repeat(16001) }, { role: "assistant", content: "x", status: "streaming" }, { role: "user", content: "x", sessionId: owner }]) assert.throws(() => messageInput(value), StorageInputError);
  for (const value of [{}, { content: "" }, { status: "invalid" }, { role: "assistant" }, { content: "x", id: owner }]) assert.throws(() => messagePatch(value), StorageInputError);
});

test("repository validates untrusted write inputs before accessing a database", async () => {
  const repo = createConversationRepository();
  await assert.rejects(repo.create(owner, { sessionId: owner }), StorageInputError);
  await assert.rejects(repo.list(owner, { limit: 51, offset: 0 }), StorageInputError);
  await assert.rejects(repo.get(owner, "bad"), StorageInputError);
  await assert.rejects(repo.appendMessage(owner, conversationId, { role: "system", content: "x" }), StorageInputError);
  await assert.rejects(repo.updateMessage(owner, conversationId, randomUUID(), { role: "user" }), StorageInputError);
});

test("HTTP create/list/get use cookie-derived owner and return bounded, noncached envelopes", async () => {
  const { handlers, counts } = fixture();
  const created = await handlers.create(request("POST", token, "", '{"title":" Hello "}'));
  assert.equal(created.status, 201); assert.equal((await created.json()).conversation.title, "Hello");
  const listed = await handlers.list(request("GET", token, "?limit=2&offset=1"));
  assert.deepEqual((await listed.json()).pagination, { limit: 2, offset: 1, nextOffset: null });
  const found = await handlers.get(request(), context());
  assert.equal(found.status, 200); assert.equal((await found.json()).conversation.id, conversationId);
  assert.equal(found.headers.get("cache-control"), "no-store");
  assert.equal(found.headers.get("access-control-allow-origin"), null);
  assert.equal(found.headers.get("set-cookie"), null);
  assert.deepEqual(counts(), { calls: 3, inserts: 0 });
});

test("missing, invalid, unknown and expired sessions never create sessions or access conversations", async () => {
  const { handlers, counts } = fixture();
  for (const value of [null, "invalid", "b".repeat(64), "c".repeat(64)]) {
    for (const response of [await handlers.list(request("GET", value)), await handlers.get(request("GET", value), context()), await handlers.create(request("POST", value, "", "{}"))]) {
      assert.equal(response.status, 401); assert.equal((await response.json()).error.code, "SESSION_REQUIRED"); assert.equal(response.headers.get("set-cookie"), null);
    }
  }
  assert.deepEqual(counts(), { calls: 0, inserts: 0 });
});

test("state changes require same-origin; client ownership IDs and malformed requests are rejected", async () => {
  const { handlers, counts } = fixture();
  for (const Origin of ["https://other.example", "null", "http://localhost:1", ""]) {
    assert.equal((await handlers.create(request("POST", token, "", "{}", { Origin }))).status, 403);
  }
  assert.equal((await handlers.create(request("POST", token, "", "{}", { "Sec-Fetch-Site": "cross-site" }))).status, 403);
  for (const body of ['{"sessionId":"'+owner+'"}', "{bad", '{"title":" "}', '[]']) assert.equal((await handlers.create(request("POST", token, "", body))).status, 400);
  assert.equal((await handlers.create(request("POST", token, "", "{}", { "Content-Type": "text/plain" }))).status, 415);
  assert.equal((await handlers.create(request("POST", token, "", "{}", { "Content-Encoding": "gzip" }))).status, 415);
  assert.equal((await handlers.create(request("POST", token, "", "{}", { "Content-Length": String(STORAGE_LIMITS.bodyBytes + 1) }))).status, 413);
  assert.equal((await handlers.create(request("POST", token, "", JSON.stringify({ title: "界".repeat(1000) }), { "Content-Length": "1" }))).status, 413);
  assert.equal((await handlers.get(request(), context("bad"))).status, 400);
  assert.equal((await handlers.list(request("GET", token, "?limit=51"))).status, 400);
  assert.deepEqual(counts(), { calls: 0, inserts: 0 });
});

test("unavailable lookups return uniform 404 and database failures are safe", async () => {
  const { handlers } = fixture();
  const missing = await handlers.get(request(), context(randomUUID()));
  assert.equal(missing.status, 404); assert.equal((await missing.json()).error.code, "NOT_FOUND");
  const failed = fixture(true).handlers;
  for (const response of [await failed.list(request()), await failed.get(request(), context()), await failed.create(request("POST", token, "", "{}"))]) {
    assert.equal(response.status, 503); const json = await response.json();
    assert.equal(json.error.code, "STORAGE_UNAVAILABLE"); assert.ok(!JSON.stringify(json).includes("DO_NOT_LEAK"));
  }
  const sessionFailure = createConversationHandlers({ service: { async getExistingSession() { throw Error("DO_NOT_LEAK"); } } });
  assert.equal((await sessionFailure.list(request())).status, 503);
});
