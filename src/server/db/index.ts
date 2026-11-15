import "server-only";
import { createDatabaseConnection } from "./connection";

function createConnection() { return createDatabaseConnection(process.env.DATABASE_URL); }

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
