import type { Config } from "@netlify/functions";
import { createDatabaseConnection } from "../../src/server/db/connection.js";
import { runSessionCleanup } from "../../src/server/abuse/cleanup-core.js";
import { retentionPolicy } from "../../src/server/abuse/retention-policy.js";

/** Scheduled-only: Netlify does not expose scheduled functions as HTTP routes. */
export async function scheduledCleanup(env = process.env, connect = createDatabaseConnection, run = runSessionCleanup) {
  // Dry-run until an operator explicitly reviews retention and opts in.
  const policy = retentionPolicy(env);
  const connection = connect(env.DATABASE_URL);
  try { return await run(() => connection.db, policy, env.SESSION_CLEANUP_APPLY === "true"); }
  finally { await connection.pool.end(); }
}

export default async function handler() {
  try {
    await scheduledCleanup();
    return new Response(null, { status: 204 });
  } catch {
    console.error("Scheduled session cleanup failed; database details withheld.");
    // Make scheduler failures visible without logging tokens, content or credentials.
    throw new Error("Scheduled session cleanup failed.");
  }
}
export const config: Config = { schedule: "*/15 * * * *" };
