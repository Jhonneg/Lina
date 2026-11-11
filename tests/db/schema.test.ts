import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { mock, test } from "node:test";
import { Pool } from "pg";
import { getTableConfig } from "drizzle-orm/pg-core";
import { conversations, messageRole, messages, messageStatus, sessions } from "../../src/server/db/schema";

test("database schema enforces required fields, UUID/time defaults and database enums", () => {
  assert.deepEqual(messageRole.enumValues, ["user", "assistant"]);
  assert.deepEqual(messageStatus.enumValues, ["completed", "interrupted", "failed", "pending"]);
  for (const table of [sessions, conversations, messages]) {
    assert.equal(table.id.primary, true);
    assert.equal(table.id.hasDefault, true);
    assert.equal(table.createdAt.notNull, true);
    assert.equal(table.createdAt.hasDefault, true);
    assert.equal(table.createdAt.getSQLType(), "timestamp with time zone");
  }
  assert.equal(sessions.tokenHash.isUnique, true);
  assert.equal(sessions.tokenHash.notNull, true);
  assert.equal(sessions.expiresAt.notNull, true);
  assert.equal(sessions.expiresAt.hasDefault, false);
  assert.equal(conversations.title.notNull, false);
  assert.equal(conversations.updatedAt.hasDefault, true);
  assert.equal(messages.role.notNull, true);
  assert.equal(messages.content.notNull, true);
  assert.equal(messages.status.notNull, true);
  assert.equal(messages.status.default, "completed");
});

test("ownership foreign keys cascade and list indexes include deterministic ordering", () => {
  for (const [table, parent] of [[conversations, sessions], [messages, conversations]] as const) {
    const config = getTableConfig(table);
    assert.equal(config.foreignKeys.length, 1);
    const foreignKey = config.foreignKeys[0];
    assert.equal(foreignKey.onDelete, "cascade");
    assert.equal(foreignKey.reference().foreignTable, parent);
    assert.equal(foreignKey.reference().columns[0].notNull, true);
  }
  assert.deepEqual(getTableConfig(sessions).indexes.map(x => x.config.name), ["sessions_expires_at_idx"]);
  assert.deepEqual(getTableConfig(conversations).indexes.map(x => x.config.name), ["conversations_session_updated_idx"]);
  assert.deepEqual(getTableConfig(messages).indexes.map(x => x.config.name), ["messages_conversation_created_idx"]);
});

test("committed initial migration contains table constraints, enums and ordered indexes", () => {
  const files = readdirSync("drizzle").filter(file => file.endsWith(".sql"));
  assert.ok(files.includes("0000_initial_database.sql"));
  const sql = readFileSync("drizzle/0000_initial_database.sql", "utf8");
  for (const name of ["sessions", "conversations", "messages"]) assert.ok(sql.includes(`CREATE TABLE "${name}"`));
  assert.equal((sql.match(/PRIMARY KEY DEFAULT gen_random_uuid\(\)/g) ?? []).length, 3);
  assert.equal((sql.match(/ON DELETE cascade/g) ?? []).length, 2);
  assert.match(sql, /CREATE TYPE "public"\."message_role" AS ENUM\('user', 'assistant'\)/);
  assert.match(sql, /CREATE TYPE "public"\."message_status" AS ENUM\('completed', 'interrupted', 'failed'\)/);
  assert.match(sql, /"token_hash" text NOT NULL/);
  assert.match(sql, /UNIQUE\("token_hash"\)/);
  assert.match(sql, /"status" "message_status" DEFAULT 'completed' NOT NULL/);
  assert.match(sql, /\("session_id","updated_at" DESC NULLS LAST,"id"\)/);
  assert.match(sql, /\("conversation_id","created_at","id"\)/);
  assert.ok(!sql.includes("timestamp without time zone"));
});

test("database client imports without configuration and initializes lazily without connections or secret logs", async () => {
  const original = process.env.DATABASE_URL;
  const connect = mock.method(Pool.prototype, "connect", () => { throw new Error("Database network disabled in tests"); });
  const logging = mock.method(console, "error", () => {});
  try {
    delete process.env.DATABASE_URL;
    const { getDatabase } = await import("../../src/server/db");
    assert.equal(connect.mock.callCount(), 0);
    assert.throws(() => getDatabase(), /Database is not configured/);
    process.env.DATABASE_URL = "https://DO_NOT_LEAK.invalid";
    assert.throws(() => getDatabase(), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "DATABASE_URL must be a valid PostgreSQL connection URL.");
      return true;
    });
    process.env.DATABASE_URL = "postgresql://test:DO_NOT_LEAK@127.0.0.1:1/unused";
    const db = getDatabase();
    assert.equal(getDatabase(), db);
    assert.equal(db.$client.totalCount, 0);
    assert.equal(connect.mock.callCount(), 0);
    db.$client.emit("error", new Error("DO_NOT_LEAK"));
    assert.deepEqual(logging.mock.calls.map(x => x.arguments), [["An idle database connection failed."]]);
    await db.$client.end();
  } finally {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
    connect.mock.restore();
    logging.mock.restore();
  }
});
