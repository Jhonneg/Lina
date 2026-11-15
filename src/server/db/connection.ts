import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema";

export function databaseTimeouts(pooled: boolean): PoolConfig {
  if (!pooled) return { statement_timeout: 5000, lock_timeout: 3000, query_timeout: 8000 };
  // PgBouncer transaction pooling cannot preserve arbitrary startup/session SETs.
  // Require bounded role defaults, provisioned through the DIRECT migration URL.
  return { query_timeout: 8000, async onConnect(client) {
    const result = await client.query<{ name: string; setting: string }>(
      "SELECT name, setting FROM pg_settings WHERE name IN ('statement_timeout', 'lock_timeout')");
    for (const [name, max] of [["statement_timeout", 5000], ["lock_timeout", 3000]] as const) {
      const value = Number(result.rows.find(row => row.name === name)?.setting);
      if (!Number.isFinite(value) || value <= 0 || value > max) throw new Error("Database role timeouts must be configured before pooled access.");
    }
  } };
}

export function createDatabaseConnection(connectionString: string | undefined) {
  connectionString = connectionString?.trim();
  if (!connectionString) throw new Error("Database is not configured. Set DATABASE_URL on the server.");
  let pooled = false;
  try {
    const url = new URL(connectionString);
    pooled = url.hostname.endsWith(".neon.tech") && url.hostname.includes("-pooler.");
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error();
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  // pg creates sockets only when a query or connection is requested.
  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000,
    // Ordinary session/history queries need bounds too, not only usage transactions.
    ...databaseTimeouts(pooled) });
  pool.on("error", () => { console.error("An idle database connection failed."); });
  return { pool, db: drizzle(pool, { schema, logger: false }) };
}

