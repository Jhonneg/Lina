import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { abusePolicy } from "../../src/server/abuse/policy";
import { createApiGuard } from "../../src/server/abuse/guard";
import { UsageError } from "../../src/server/usage/policy";
import { createSessionHandler } from "../../src/server/session-handler";
import { createConversationHandlers } from "../../src/server/conversations/handler";
const request = () => new NextRequest("http://localhost/api/session", { method: "POST", headers: { Origin: "http://localhost" } });
test("non-billable policy is bounded, configurable and fails closed for untrusted production IP", () => {
  const policy = abusePolicy({ NODE_ENV: "test" }); assert.equal(policy.messages, 1000); assert.equal(policy.conversations, 50); assert.equal(policy.retentionDays, 7);
  assert.equal(abusePolicy({ STORAGE_MESSAGES_PER_SESSION: "0" }).messages, 0);
  for (const env of [{ API_READ_IP_MINUTE: "-1" }, { API_CLEANUP_BATCH: "1001" }, { STORAGE_MESSAGES_PER_SESSION: "NaN" }, { NODE_ENV: "production" }]) assert.throws(() => abusePolicy(env));
});
test("rate denial precedes session creation/lookup and returns safe Retry-After errors", async () => {
  let calls = 0;
  const abuse = { async take() { throw new UsageError(429, "API_RATE_LIMIT", "Request limit reached. Please try again later.", 60); } };
  const session = createSessionHandler({ abuse, service: { async getOrCreateSession() { calls++; throw Error("PRIVATE"); } } });
  const blocked = await session(request()); assert.equal(blocked.status, 429); assert.equal(blocked.headers.get("Retry-After"), "60"); assert.equal(calls, 0); assert.ok(!blocked.headers.has("Set-Cookie"));
  const handlers = createConversationHandlers({ abuse, service: { async getExistingSession() { calls++; return null; } } });
  assert.equal((await handlers.list(new NextRequest("http://localhost/api/conversations"))).status, 429); assert.equal(calls, 0);
  const cross = new NextRequest("http://localhost/api/session", { method: "POST", headers: { Origin: "https://attacker.invalid" } });
  assert.equal((await session(cross)).status, 403);
});
test("IP then verified-session admission preserves owned list pagination; database failures are safe", async () => {
  const seen: string[] = [], id = randomUUID();
  const handlers = createConversationHandlers({ abuse: { async take(_req, kind, owner) { seen.push(owner ? `${kind}:session` : `${kind}:ip`); } },
    service: { async getExistingSession() { seen.push("lookup"); return { id, expiresAt: new Date(Date.now() + 1000) }; } },
    repository: { async create() { return null; }, async get() { return null; }, async list(owner, page) { assert.equal(owner, id); return { items: [], pagination: { ...page!, nextOffset: null } }; } } });
  const response = await handlers.list(new NextRequest("http://localhost/api/conversations?limit=5&offset=2"));
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).pagination, { limit: 5, offset: 2, nextOffset: null }); assert.deepEqual(seen, ["read:ip", "lookup", "read:session"]);
  await assert.rejects(createApiGuard(() => { throw Error("PRIVATE_URL"); }, () => abusePolicy({ NODE_ENV: "test" })).take(request(), "session"), error => error instanceof UsageError && error.status === 503 && !error.message.includes("PRIVATE"));
});
