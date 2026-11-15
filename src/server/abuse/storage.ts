import "server-only";
import { eq, sql } from "drizzle-orm";
import { conversations, messages } from "../db/schema";
import { lockUsage, type UsageTransaction } from "../usage/service";
import { UsageError } from "../usage/policy";
import { abusePolicy } from "./policy";

/** Caller retains the transaction lock until all associated inserts commit. */
export async function assertStorageCapacity(tx: UsageTransaction, sessionId: string, add: { conversations?: number; messages?: number }, policy = abusePolicy()) {
  await lockUsage(tx);
  if (add.conversations) {
    const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(conversations).where(eq(conversations.sessionId, sessionId));
    if (row.count + add.conversations > policy.conversations) throw new UsageError(429, "STORAGE_LIMIT", "Conversation storage limit reached. Delete older conversations to free space.", 0);
  }
  if (add.messages) {
    const [row] = await tx.select({ count: sql<number>`count(*)::int` }).from(messages).innerJoin(conversations, eq(conversations.id, messages.conversationId)).where(eq(conversations.sessionId, sessionId));
    if (row.count + add.messages > policy.messages) throw new UsageError(429, "STORAGE_LIMIT", "Message storage limit reached. Delete older conversations to free space.", 0);
  }
}
