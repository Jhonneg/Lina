import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { automaticConversationTitle } from "../../src/server/conversations/title";
import { renameTitleInput, StorageInputError } from "../../src/server/conversations/validation";
import { createConversationRepository } from "../../src/server/conversations/repository";
import { createConversationHandlers as makeHandler } from "../../src/server/conversations/handler";
import { sessionCookieSettings } from "../../src/server/sessions";

const owner = randomUUID(), id = randomUUID();
function fixture({ authorized = true, missing = false, failing = false } = {}) {
  let calls = 0;
  const conversation = { id, title: "Renamed", createdAt: new Date(), updatedAt: new Date() };
  const check = (sessionId: string, target: string) => { assert.equal(sessionId, owner); assert.equal(target, id); calls++; if (failing) throw Error("PRIVATE_DATABASE_CONTENT"); };
  const handlers = createConversationHandlers({ service: { async getExistingSession() { return authorized ? { id: owner, expiresAt: new Date(Date.now() + 10000) } : null; } }, repository: {
    async create() { return conversation; }, async list() { return { items: [], pagination: { limit: 20, offset: 0, nextOffset: null } }; }, async get() { return null; },
    async rename(sessionId, target, input) { check(sessionId, target); return missing ? null : { ...conversation, title: renameTitleInput(input) }; },
    async remove(sessionId, target) { check(sessionId, target); return missing ? null : { id }; },
  } });
  return { handlers, calls: () => calls };
}
function request(method: string, body?: string, origin = "http://localhost", query = "") {
  return new NextRequest(`http://localhost/api/conversations/${id}${query}`, { method, body,
    headers: { Origin: origin, "Content-Type": "application/json", Cookie: `${sessionCookieSettings().name}=${"a".repeat(64)}` } });
}
const context = { params: Promise.resolve({ id }) };

test("automatic titles normalize whitespace, use word boundaries and preserve Unicode", () => {
  assert.equal(automaticConversationTitle("  Hello\n\t world   again "), "Hello world again");
  const original = "A calm introduction to a conversation with a few extra words to exceed the title length";
  const title = automaticConversationTitle(original);
  assert.ok(Array.from(title).length <= 60); assert.ok(title.endsWith("…")); assert.ok(original.startsWith(title.slice(0, -1)));
  assert.ok(original[title.length - 1] === " ");
  assert.equal(Array.from(automaticConversationTitle("🌙".repeat(70))).length, 60);
  assert.equal(automaticConversationTitle("x".repeat(70)), "x".repeat(59) + "…");
  assert.equal(automaticConversationTitle("a".repeat(60)), "a".repeat(60));
  assert.equal(automaticConversationTitle("\n"), "Untitled conversation");
});

test("rename requires a bounded non-empty title and validates before database access", async () => {
  assert.equal(renameTitleInput({ title: " A title " }), "A title");
  assert.equal(renameTitleInput({ title: "a".repeat(200) }).length, 200);
  for (const value of [{}, { title: null }, { title: " " }, { title: 2 }, { title: "x".repeat(201) }, { title: "x", sessionId: owner }]) assert.throws(() => renameTitleInput(value), StorageInputError);
  const repo = createConversationRepository();
  await assert.rejects(repo.rename(owner, id, { title: null }), StorageInputError);
  await assert.rejects(repo.remove(owner, "invalid"), StorageInputError);
});

test("PATCH and DELETE use verified session ownership and return safe noncached responses", async () => {
  const { handlers, calls } = fixture();
  const renamed = await handlers.rename(request("PATCH", '{"title":"Manual title"}'), context);
  assert.equal(renamed.status, 200); assert.equal((await renamed.json()).conversation.title, "Manual title");
  const removed = await handlers.remove(request("DELETE"), context);
  assert.deepEqual(await removed.json(), { ok: true, deletedId: id }); assert.equal(calls(), 2);
  assert.equal(removed.headers.get("cache-control"), "no-store"); assert.equal(removed.headers.get("set-cookie"), null);
  assert.equal(removed.headers.get("access-control-allow-origin"), null);
});

test("management rejects absent/expired sessions, bad origins, spoofed owners and malformed input", async () => {
  const denied = fixture({ authorized: false });
  assert.equal((await denied.handlers.rename(request("PATCH", '{"title":"x"}'), context)).status, 401);
  assert.equal((await denied.handlers.remove(request("DELETE"), context)).status, 401); assert.equal(denied.calls(), 0);
  const { handlers, calls } = fixture();
  for (const origin of ["", "null", "https://other.example"]) {
    assert.equal((await handlers.rename(request("PATCH", '{"title":"x"}', origin), context)).status, 403);
    assert.equal((await handlers.remove(request("DELETE", undefined, origin), context)).status, 403);
  }
  for (const body of ['{}', '{"title":null}', '{"title":" "}', '{"title":"x","sessionId":"'+owner+'"}', '{bad']) assert.equal((await handlers.rename(request("PATCH", body), context)).status, 400);
  assert.equal((await handlers.remove(request("DELETE", undefined, "http://localhost", "?sessionId=x"), context)).status, 400);
  assert.equal(calls(), 0);
});

test("missing/foreign conversations share 404 responses and database failures remain private", async () => {
  const missing = fixture({ missing: true }).handlers;
  assert.equal((await missing.rename(request("PATCH", '{"title":"x"}'), context)).status, 404);
  assert.equal((await missing.remove(request("DELETE"), context)).status, 404);
  const failed = fixture({ failing: true }).handlers;
  for (const response of [await failed.rename(request("PATCH", '{"title":"x"}'), context), await failed.remove(request("DELETE"), context)]) {
    assert.equal(response.status, 503); const body = await response.json();
    assert.equal(body.error.code, "STORAGE_UNAVAILABLE"); assert.ok(!JSON.stringify(body).includes("PRIVATE_DATABASE_CONTENT"));
  }
});

// In-memory contract fixtures; real admission is verified against disposable PostgreSQL.
function createConversationHandlers(options: Parameters<typeof makeHandler>[0] = {}) {
  return makeHandler({ ...options, abuse: { async take() {} } });
}
