import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { NextRequest } from "next/server";
import { getDatabase } from "../../src/server/db";
import { sessions } from "../../src/server/db/schema";
import { createSessionService } from "../../src/server/sessions";
import { createSessionHandler } from "../../src/server/session-handler";

// Guard before any client access: this file is never part of the offline test suite.
const target = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/disabled");
const designated = process.env.LAIN_SESSION_INTEGRATION_DATABASE;
if (!designated || !/^lain_session_it_[a-f0-9]{16}$/.test(designated) ||
    target.pathname !== `/${designated}` || !["localhost", "127.0.0.1"].includes(target.hostname)) {
  throw new Error("Refusing session integration tests outside the designated disposable database.");
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function request(token?: string) {
  return new NextRequest("http://localhost/api/session", {
    method: "POST", headers: { Origin: "http://localhost", ...(token ? { Cookie: `lain_session=${token}` } : {}) },
  });
}
async function check(t: TestContext, name: string, fn: () => Promise<void>) {
  await t.test(name, async () => {
    // Never let SQL driver error objects or assertion diffs log token/hash values.
    try { await fn(); } catch { assert.fail(`${name}: check failed; private details withheld.`); }
  });
}
async function expectConstraint(operation: Promise<unknown>, expected: string) {
  let code;
  try { await operation; } catch (error) {
    const failure = error as { code?: string; cause?: { code?: string } };
    code = failure.cause?.code ?? failure.code;
  }
  assert.ok(code === expected);
}

test("PostgreSQL anonymous-session integration", { timeout: 20_000 }, async (t) => {
  const db = getDatabase();
  const handler = createSessionHandler({ production: false });
  const service = createSessionService();
  let token = "";
  let originalId = "";
  const count = async () => (await db.select({ count: sql<number>`count(*)::int` }).from(sessions))[0].count;
  try {
    await check(t, "existing Drizzle migrations apply to the empty disposable database", async () => {
      await migrate(db, { migrationsFolder: "drizzle" });
      const journal = await db.execute(sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`);
      assert.ok(journal.rows[0].count === readMigrationFiles({ migrationsFolder: "drizzle" }).length);
      assert.ok(await count() === 0);
    });
    await check(t, "first request creates one record with only a SHA-256 token hash", async () => {
      const response = await handler(request());
      assert.ok(response.status === 200);
      token = response.cookies.get("lain_session")!.value;
      const metadata = await response.json();
      const [row] = await db.select().from(sessions);
      originalId = row.id;
      assert.ok(/^[a-f0-9]{64}$/.test(token));
      assert.ok(row.tokenHash === hash(token) && row.tokenHash !== token);
      assert.ok(Object.keys(row).sort().join(",") === "createdAt,expiresAt,id,tokenHash");
      assert.ok(metadata.session.id === row.id);
      assert.ok(!JSON.stringify(metadata).includes(token) && !JSON.stringify(metadata).includes(row.tokenHash));
      assert.ok(row.expiresAt.getTime() - row.createdAt.getTime() > 29 * 86400000);
      assert.ok(await count() === 1);
    });
    await check(t, "valid cookie resolves the same session without duplicate records or writes", async () => {
      const before = await db.execute(sql`SELECT xmin::text AS version FROM sessions WHERE id = ${originalId}::uuid`);
      const response = await handler(request(token));
      assert.ok(response.status === 200 && response.headers.get("set-cookie") === null);
      assert.ok((await response.json()).session.id === originalId);
      assert.ok((await service.getExistingSession(token))?.id === originalId);
      assert.ok(await count() === 1);
      const after = await db.execute(sql`SELECT xmin::text AS version FROM sessions WHERE id = ${originalId}::uuid`);
      assert.ok(before.rows[0].version === after.rows[0].version);
    });
    await check(t, "invalid and unknown tokens create distinct replacements", async () => {
      for (const value of ["invalid", randomBytes(32).toString("hex")]) {
        const response = await handler(request(value));
        assert.ok(response.status === 200 && Boolean(response.cookies.get("lain_session")));
        assert.ok((await response.json()).session.id !== originalId);
      }
      assert.ok(await count() === 3);
    });
    await check(t, "expired sessions cannot resolve and are replaced without deleting old rows", async () => {
      await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.id, originalId));
      assert.ok(await service.getExistingSession(token) === null);
      const response = await handler(request(token));
      assert.ok((await response.json()).session.id !== originalId);
      assert.ok(Boolean(response.cookies.get("lain_session")) && await count() === 4);
      assert.ok((await db.select().from(sessions).where(eq(sessions.id, originalId))).length === 1);
    });
    await check(t, "cookie Expires equals persisted expiry even when session creation is delayed", async () => {
      // Model request/DB latency deterministically rather than depend on a second boundary.
      const delayed = createSessionService(undefined, () => new Date(Date.now() - 5000));
      const response = await createSessionHandler({ service: delayed, production: false })(request());
      const metadata = await response.json();
      const [row] = await db.select().from(sessions).where(eq(sessions.id, metadata.session.id));
      const expires = response.headers.get("set-cookie")!.match(/expires=([^;]+)/i)![1];
      assert.ok(Date.parse(expires) === Math.floor(row.expiresAt.getTime() / 1000) * 1000);
      assert.ok(metadata.session.expiresAt === row.expiresAt.toISOString());
    });
    await check(t, "PostgreSQL enforces unique hashes, primary keys and required fields", async () => {
      const [row] = await db.select().from(sessions).where(eq(sessions.id, originalId));
      const before = await count();
      const future = new Date(Date.now() + 86400000);
      await expectConstraint(db.insert(sessions).values({ tokenHash: row.tokenHash, expiresAt: future }), "23505");
      await expectConstraint(db.insert(sessions).values({ id: row.id, tokenHash: "constraint-fixture", expiresAt: future }), "23505");
      await expectConstraint(db.execute(sql`INSERT INTO sessions (expires_at) VALUES (now())`), "23502");
      await expectConstraint(db.execute(sql`INSERT INTO sessions (token_hash) VALUES ('missing-expiry-fixture')`), "23502");
      assert.ok(await count() === before);
    });
  } catch {
    assert.fail("Session PostgreSQL integration failed; private database details withheld.");
  } finally {
    await db.$client.end();
  }
});
