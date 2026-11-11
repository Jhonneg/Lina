import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { createSessionService, sessionCookieSettings, SESSION_LIFETIME_SECONDS, type SessionMetadata, type SessionStore } from "../../src/server/sessions";
import { createSessionHandler } from "../../src/server/session-handler";

const now = new Date("2026-11-11T12:00:00Z");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const rows = new Map<string, SessionMetadata>();
  let reads = 0, writes = 0;
  const store: SessionStore = {
    async findByHash(key) { reads++; return rows.get(key) ?? null; },
    async insert(key, expiresAt) { writes++; const row = { id: randomUUID(), expiresAt }; rows.set(key, row); return row; },
  };
  const service = createSessionService(store, () => now);
  return { rows, service, counts: () => ({ reads, writes }), store };
}
function request({ token, origin = "http://localhost", production = false, site, body }: {
  token?: string; origin?: string | null; production?: boolean; site?: string; body?: string;
} = {}) {
  const headers = new Headers();
  if (origin !== null) headers.set("Origin", origin);
  if (token !== undefined) headers.set("Cookie", `${sessionCookieSettings(production).name}=${token}`);
  if (site) headers.set("Sec-Fetch-Site", site);
  return new NextRequest("http://localhost/api/session", { method: "POST", headers, body });
}

test("new session uses a random opaque token and persists only its SHA-256 hash for 30 days", async () => {
  const { service, rows, counts } = fixture();
  const first = await service.getOrCreateSession(undefined);
  assert.match(first.newToken!, /^[a-f0-9]{64}$/);
  assert.equal(first.session.expiresAt.getTime(), now.getTime() + SESSION_LIFETIME_SECONDS * 1000);
  assert.ok(rows.has(hash(first.newToken!)));
  assert.ok(!rows.has(first.newToken!));
  assert.deepEqual(counts(), { reads: 0, writes: 1 });
  const second = await service.getOrCreateSession(undefined);
  assert.ok(first.newToken !== second.newToken);
  assert.ok(first.session.id !== second.session.id);
});

test("valid session lookup and get-or-create reuse metadata without additional writes or rotation", async () => {
  const { service, counts } = fixture();
  const original = await service.getOrCreateSession(undefined);
  assert.deepEqual(await service.getExistingSession(original.newToken), original.session);
  const reused = await service.getOrCreateSession(original.newToken);
  assert.deepEqual(reused.session, original.session);
  assert.equal(reused.newToken, undefined);
  assert.deepEqual(counts(), { reads: 2, writes: 1 });
});

test("missing/invalid cookie tokens cannot resolve an existing session or cause a lookup", async () => {
  const { service, counts } = fixture();
  for (const token of [undefined, "", "short", "a".repeat(63), "a".repeat(65), "A".repeat(64), randomUUID(), "x".repeat(10000)]) {
    assert.equal(await service.getExistingSession(token), null);
  }
  assert.deepEqual(counts(), { reads: 0, writes: 0 });
  const fresh = await service.getOrCreateSession("invalid");
  assert.ok(fresh.newToken);
  assert.deepEqual(counts(), { reads: 0, writes: 1 });
});

test("unknown and expired tokens are replaced without deleting existing session rows", async () => {
  for (const expiredBy of [0, 1000]) {
    const { service, rows, counts } = fixture();
    const old = await service.getOrCreateSession(undefined);
    rows.set(hash(old.newToken!), { ...old.session, expiresAt: new Date(now.getTime() - expiredBy) });
    assert.equal(await service.getExistingSession(old.newToken), null);
    assert.equal(counts().writes, 1);
    const replacement = await service.getOrCreateSession(old.newToken);
    assert.ok(replacement.newToken !== old.newToken);
    assert.ok(replacement.session.id !== old.session.id);
    assert.equal(rows.size, 2);
  }
  const { service } = fixture();
  const replacement = await service.getOrCreateSession("0".repeat(64));
  assert.ok(replacement.newToken);
});

test("endpoint creates secure cookies and exposes only public metadata", async () => {
  for (const production of [false, true]) {
    const { service, rows } = fixture();
    const handler = createSessionHandler({ service, production });
    const response = await handler(request({ production }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    const settings = sessionCookieSettings(production);
    const cookie = response.cookies.get(settings.name)!;
    assert.ok(cookie);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, "lax");
    assert.equal(Boolean(cookie.secure), production);
    assert.equal(cookie.path, "/");
    assert.ok(cookie.expires instanceof Date);
    assert.equal(cookie.expires.getTime(), now.getTime() + SESSION_LIFETIME_SECONDS * 1000);
    assert.equal(cookie.domain, undefined);
    const header = response.headers.get("set-cookie")!;
    assert.match(header, /Expires=/i);
    assert.doesNotMatch(header, /Max-Age=/i);
    if (production) assert.ok(settings.name.startsWith("__Host-"));
    const json = await response.json();
    assert.deepEqual(Object.keys(json), ["ok", "session"]);
    assert.deepEqual(Object.keys(json.session), ["id", "expiresAt"]);
    assert.equal(json.session.id, rows.get(hash(cookie.value))?.id);
    assert.equal(json.session.expiresAt, new Date(now.getTime() + 2592000000).toISOString());
    assert.ok(!JSON.stringify(json).includes(cookie.value));
    assert.ok(!JSON.stringify(json).includes(hash(cookie.value)));
  }
});

test("endpoint missing/invalid/expired cookie replacement and valid reuse do not refresh valid cookies", async () => {
  const { service, rows, counts } = fixture();
  const handler = createSessionHandler({ service, production: false });
  const first = await handler(request());
  const token = first.cookies.get("lain_session")!.value;
  const metadata = await first.json();
  const reused = await handler(request({ token }));
  assert.deepEqual(await reused.json(), metadata);
  assert.equal(reused.headers.get("set-cookie"), null);
  assert.equal(counts().writes, 1);
  const invalid = await handler(request({ token: "invalid" }));
  assert.ok(invalid.cookies.get("lain_session"));
  rows.set(hash(token), { id: metadata.session.id, expiresAt: new Date(now) });
  const expired = await handler(request({ token }));
  assert.ok(expired.cookies.get("lain_session"));
  assert.ok((await expired.json()).session.id !== metadata.session.id);
});

test("same-origin protection rejects mismatched/missing/null origins before database access", async () => {
  const { service, counts } = fixture();
  const handler = createSessionHandler({ service });
  for (const options of [
    { origin: null }, { origin: "null" }, { origin: "https://other.example" },
    { origin: "http://localhost:3000" }, { origin: "https://localhost" }, { site: "cross-site" },
  ]) {
    const response = await handler(request(options));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "FORBIDDEN_ORIGIN");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  assert.deepEqual(counts(), { reads: 0, writes: 0 });
  assert.equal((await handler(request({ site: "same-origin" }))).status, 200);
});

test("client-supplied session IDs are ignored, never used as ownership proof", async () => {
  const { service, counts } = fixture();
  const suppliedId = randomUUID();
  const response = await createSessionHandler({ service })(request({ body: JSON.stringify({ sessionId: suppliedId }) }));
  assert.equal(response.status, 200);
  assert.ok((await response.json()).session.id !== suppliedId);
  assert.deepEqual(counts(), { reads: 0, writes: 1 });
});

test("database lookup and insertion failures yield safe noncached errors without setting cookies", async () => {
  for (const token of [undefined, "a".repeat(64)]) {
    const store: SessionStore = {
      async findByHash() { throw new Error("DO_NOT_LEAK token_hash password URL"); },
      async insert() { throw new Error("DO_NOT_LEAK token_hash password URL"); },
    };
    const response = await createSessionHandler({ service: createSessionService(store) })(request({ token }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.error.code, "SESSION_UNAVAILABLE");
    assert.ok(!JSON.stringify(body).includes("DO_NOT_LEAK"));
    assert.ok(!JSON.stringify(body).includes("token_hash"));
  }
});
