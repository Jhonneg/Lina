import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

function createConnection() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("Database is not configured. Set DATABASE_URL on the server.");
  try {
    const url = new URL(connectionString);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error();
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  // pg creates sockets only when a query or connection is requested.
  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000 });
  pool.on("error", () => { console.error("An idle database connection failed."); });
  return { pool, db: drizzle(pool, { schema, logger: false }) };
}

type Connection = ReturnType<typeof createConnection>;
const developmentCache = globalThis as typeof globalThis & { lainDatabase?: Connection };
let connection: Connection | undefined;

/** Lazy server-only access; importing this module requires neither config nor a database. */
export function getDatabase() {
  if (!connection) {
    connection = (process.env.NODE_ENV === "development" ? developmentCache.lainDatabase : undefined) ?? createConnection();
    if (process.env.NODE_ENV === "development") developmentCache.lainDatabase = connection;
  }
  return connection.db;
}
