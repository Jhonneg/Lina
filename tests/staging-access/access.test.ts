import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { NextRequest, NextResponse } from "next/server";
import { ACCESS_TTL_SECONDS, accessCookie, accessPolicy, createAccessToken, stagingAccessFailure, validAccessToken } from "../../src/server/staging-access";
import { createStagingAccessHandlers } from "../../src/server/staging-access/handler";
import { UsageError } from "../../src/server/usage/policy";
import { abusePolicy } from "../../src/server/abuse/policy";
import { createSessionHandler } from "../../src/server/session-handler";
import { createChatHandler } from "../../src/server/chat-handler";
import { createChatStreamHandler } from "../../src/server/chat-stream-handler";
import { createConversationHandlers } from "../../src/server/conversations/handler";
import { createChatVoiceHandler } from "../../src/server/cloud-voice/chat-handler";
import { createCloudVoiceHandler } from "../../src/server/cloud-voice/handler";
const secret = randomBytes(32).toString("hex");
async function restricted(work: () => Promise<void>) {
  const names = ["NODE_ENV", "STAGING_ACCESS_MODE", "STAGING_ACCESS_SECRET"], before = names.map(n => process.env[n]);
  Object.assign(process.env, { NODE_ENV: "production", STAGING_ACCESS_MODE: "restricted", STAGING_ACCESS_SECRET: secret });
  try { await work(); } finally { names.forEach((n, i) => { if (before[i] === undefined) delete process.env[n]; else process.env[n] = before[i]; }); }
}
const request = (path = "/api/session", token?: string, method = "POST", body: unknown = { secret }) => new NextRequest(`https://lain.example${path}`, {
  method, headers: { Origin: "https://lain.example", "Content-Type": "application/json", ...(token ? { Cookie: `${accessCookie(true).name}=${token}` } : {}) },
  ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
});
test("production defaults fail closed; disablement is explicit and invalid configuration is rejected", async () => {
  assert.throws(() => accessPolicy({ NODE_ENV: "production" }));
  assert.throws(() => accessPolicy({ STAGING_ACCESS_MODE: "typo", STAGING_ACCESS_SECRET: secret }));
  assert.throws(() => accessPolicy({ STAGING_ACCESS_MODE: "restricted", STAGING_ACCESS_SECRET: "weak" }));
  assert.equal(accessPolicy({ NODE_ENV: "production", STAGING_ACCESS_MODE: "disabled" }).restricted, false);
  await restricted(async () => { delete process.env.STAGING_ACCESS_SECRET; assert.equal(stagingAccessFailure(request())?.status, 503); });
});
test("signed cookies reject expiry, tampering, malformed timestamps and key rotation", () => {
  const now = 1794729600000, token = createAccessToken(secret, now);
  assert.ok(validAccessToken(token, secret, now));
  assert.ok(!token.includes(secret));
  assert.ok(!validAccessToken(token, secret, now + ACCESS_TTL_SECONDS * 1000));
  assert.ok(!validAccessToken(token, secret, now - 1_000));
  assert.ok(!validAccessToken(token, randomBytes(32).toString("hex"), now));
  assert.ok(!validAccessToken(token.slice(0, -1) + (token.endsWith("0") ? "1" : "0"), secret, now));
  for (const value of [undefined, "x".repeat(1000), token.replace("v1.", "v2."), secret]) assert.ok(!validAccessToken(value, secret, now));
});
test("all direct DB/provider handler entry points reject visitors before dependencies are called", async () => {
  await restricted(async () => {
    let touched = 0;
    const touch = async () => { touched++; throw Error("Private database details"); };
    const service = { getExistingSession: touch, getOrCreateSession: touch }, abuse = { take: touch };
    const repository = { create: touch, list: touch, get: touch, rename: touch, remove: touch };
    const conversation = createConversationHandlers({ repository, service, abuse });
    const handlers = [createSessionHandler({ service, abuse }), createChatHandler({ getAdapter: () => { touched++; throw Error(); } }),
      createChatStreamHandler({ getAdapter: () => { touched++; throw Error(); } }),
      createChatVoiceHandler({ service, development: () => { touched++; return true; } }),
      createCloudVoiceHandler({ development: () => { touched++; return true; } }),
      ...[conversation.create, conversation.list, conversation.get, conversation.rename, conversation.remove].map(handler => (req: NextRequest) => handler(req, { params: Promise.resolve({ id: crypto.randomUUID() }) }))];
    for (const handler of handlers) {
      for (const token of [undefined, "bad", createAccessToken(secret, Date.now() - ACCESS_TTL_SECONDS * 1000 - 1_000)]) {
        const response = await handler(request("/api/direct", token));
        assert.equal(response.status, 401); assert.equal((await response.json()).error.code, "STAGING_ACCESS_REQUIRED");
      }
    }
    assert.equal(touched, 0);
    for (const handler of handlers) {
      const response = await handler(request("/api/direct", createAccessToken(secret)));
      const value = await response.json();
      assert.notEqual(value.error?.code, "STAGING_ACCESS_REQUIRED");
      assert.notEqual(value.error?.code, "STAGING_ACCESS_UNAVAILABLE");
    }
    assert.ok(touched > 0);
  });
});
test("operator login uses persistent admission, creates a secure cookie, and permits the existing session lifecycle", async () => {
  await restricted(async () => {
    let admissions = 0, sessions = 0;
    const auth = createStagingAccessHandlers({ abuse: { async take(_req, kind) { assert.equal(kind, "access"); admissions++; } } });
    const status = await auth.GET(request("/api/staging-access", undefined, "GET")); assert.equal((await status.json()).authorized, false);
    const login = await auth.POST(request("/api/staging-access")); assert.equal(login.status, 200);
    assert.ok(!(await login.text()).includes(secret));
    const cookie = (login as NextResponse).cookies.get(accessCookie(true).name)!;
    assert.equal(cookie.httpOnly, true); assert.equal(cookie.secure, true); assert.equal(cookie.sameSite, "lax"); assert.equal(cookie.path, "/"); assert.equal(cookie.domain, undefined); assert.equal(cookie.maxAge, ACCESS_TTL_SECONDS);
    assert.equal(stagingAccessFailure(request("/api/session", cookie.value)), null);
    assert.equal((await (await auth.GET(request("/api/staging-access", cookie.value, "GET"))).json()).authorized, true);
    const handler = createSessionHandler({ service: { async getOrCreateSession() { sessions++; return { session: { id: crypto.randomUUID(), expiresAt: new Date(Date.now() + 1000) }, newToken: undefined }; } }, abuse: { async take() {} } });
    assert.equal((await handler(request("/api/session", cookie.value))).status, 200);
    assert.equal(sessions, 1); assert.equal(admissions, 1);
    const logout = auth.DELETE(request("/api/staging-access", cookie.value, "DELETE")) as NextResponse;
    assert.equal(logout.cookies.get(accessCookie(true).name)?.maxAge, 0);
  });
});
test("wrong credentials consume admission; rate and database failures never issue cookies", async () => {
  await restricted(async () => {
    const defaults = abusePolicy({ NODE_ENV: "test" }).limits.access;
    assert.equal(defaults.ipMinute, 5); assert.equal(defaults.ipDay, 30);
    let admissions = 0;
    const handlers = createStagingAccessHandlers({ abuse: { async take() { admissions++; if (admissions > 2) throw new UsageError(429, "API_RATE_LIMIT", "Wait.", 60); } } });
    assert.equal((await handlers.POST(request("/api/staging-access", undefined, "POST", { secret: "wrong" }))).status, 401);
    assert.equal((await handlers.POST(request("/api/staging-access", undefined, "POST", { secret: "wrong" }))).status, 401);
    const limited = await handlers.POST(request("/api/staging-access")); assert.equal(limited.status, 429); assert.equal(limited.headers.get("Retry-After"), "60"); assert.equal(limited.headers.has("Set-Cookie"), false);
    const failing = createStagingAccessHandlers({ abuse: { async take() { throw Error("PRIVATE_DATABASE_PASSWORD"); } } });
    const failed = await failing.POST(request("/api/staging-access")); assert.equal(failed.status, 503); assert.equal(failed.headers.has("Set-Cookie"), false); assert.ok(!(await failed.text()).includes("PRIVATE"));
  });
});
test("CSRF, excessive input, disabled login and invalid config fail before DB admission", async () => {
  await restricted(async () => {
    let calls = 0; const handlers = createStagingAccessHandlers({ abuse: { async take() { calls++; } } });
    const insecure = new Request("http://lain.example/api/staging-access", { method: "POST", headers: { Origin: "http://lain.example" } });
    assert.equal((await handlers.POST(insecure)).status, 403);
    const cross = request("/api/staging-access"); cross.headers.set("Origin", "https://other.example");
    assert.equal((await handlers.POST(cross)).status, 403); assert.equal(handlers.DELETE(cross).status, 403);
    const absent = request("/api/staging-access"); absent.headers.delete("Origin"); assert.equal((await handlers.POST(absent)).status, 403);
    assert.equal((await handlers.POST(request("/api/staging-access", undefined, "POST", { secret: "x".repeat(2000) }))).status, 413);
    process.env.STAGING_ACCESS_SECRET = "invalid"; assert.equal((await handlers.POST(request())).status, 503);
    process.env.STAGING_ACCESS_MODE = "disabled"; assert.equal((await handlers.POST(request())).status, 404); assert.equal(stagingAccessFailure(request()), null);
    assert.equal(calls, 0);
  });
});
