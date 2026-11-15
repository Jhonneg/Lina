import { sql } from "drizzle-orm";
import type { UsageTransaction } from "../usage/service";

export const lockUsage = async (tx: UsageTransaction) => {
  await tx.execute(sql`SET LOCAL statement_timeout = '5000'`); await tx.execute(sql`SET LOCAL lock_timeout = '3000'`);
  // One short global admission lock serializes budget and concurrency checks across processes.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(761915041)`);
};
