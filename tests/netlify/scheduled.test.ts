import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClientBase } from "pg";
import { databaseTimeouts, createDatabaseConnection } from "../../src/server/db/connection";
import { scheduledCleanup, config } from "../../netlify/functions/session-cleanup.mjs";
import { retentionPolicy } from "../../src/server/abuse/retention-policy";

test("scheduled entry point imports in plain Node and defaults to dry-run, with bounded retention", async () => {
  let ended = 0, applied: boolean | undefined;
  const connection = { db: {}, pool: { async end() { ended++; } } } as unknown as ReturnType<typeof createDatabaseConnection>;
  const run = async (_db: unknown, policy: ReturnType<typeof retentionPolicy>, apply = false) => {
    assert.equal(policy.cleanupBatch, 100); assert.equal(policy.retentionDays, 7); applied = apply;
    return { dryRun: !apply, eligibleSessions: 0, maxRows: 100 };
  };
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", DATABASE_URL: "not-logged" };
  assert.equal(config.schedule, "*/15 * * * *");
  await scheduledCleanup(env, () => connection, run); assert.equal(applied, false); assert.equal(ended, 1);
  await scheduledCleanup({ ...env, SESSION_CLEANUP_APPLY: "true" }, () => connection, run); assert.equal(applied, true);
  await assert.rejects(scheduledCleanup(env, () => connection, async () => { throw Error("fixture"); })); assert.equal(ended, 3);
  assert.throws(() => retentionPolicy({ API_CLEANUP_BATCH: "1001" }));
  assert.throws(() => retentionPolicy({ SESSION_EXPIRED_RETENTION_DAYS: "NaN" }));
});
test("database creation stays lazy and Neon pooler requires safe role defaults without startup SETs", async () => {
  const connection = createDatabaseConnection("postgresql://fixture:unused@ep-test-pooler.us-east-2.aws.neon.tech/test?sslmode=verify-full");
  assert.equal(connection.pool.totalCount, 0); await connection.pool.end();
  assert.throws(() => createDatabaseConnection(undefined)); assert.throws(() => createDatabaseConnection("https://example.com"));
  assert.equal(databaseTimeouts(false).statement_timeout, 5000);
  const settings = databaseTimeouts(true); assert.equal(settings.statement_timeout, undefined); assert.equal(settings.lock_timeout, undefined);
  const client = (statement: string, lock: string) => ({ query: async () => ({ rows: [{ name: "statement_timeout", setting: statement }, { name: "lock_timeout", setting: lock }] }) }) as unknown as ClientBase;
  await settings.onConnect!(client("5000", "3000"));
  for (const values of [["0", "3000"], ["5000", "0"], ["5001", "3000"], ["5000", "3001"], ["NaN", "3000"]])
    await assert.rejects(async () => settings.onConnect!(client(values[0], values[1])));
});
