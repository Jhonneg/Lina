import { and, asc, eq, inArray, lt, notExists, sql } from "drizzle-orm";
import type { getDatabase } from "../db";
import { apiRateBuckets, conversations, messages, sessions, usageReservations, usageUtterances, streamRequests } from "../db/schema";
import { lockUsage } from "../db/usage-lock";


/** Explicit maintenance only. Never invoked from startup or an HTTP handler. */
export async function runSessionCleanup(database: typeof getDatabase, policy: { retentionDays: number; cleanupBatch: number }, apply = false) {
  const db = database();
  return db.transaction(async tx => {
    await lockUsage(tx);
    // Keep the bounded maintenance batch within Netlify's 30-second schedule.
    await tx.execute(sql`SET LOCAL statement_timeout = '1000'`);
    const clock = await tx.execute(sql`SELECT clock_timestamp() AS at`), now = new Date(clock.rows[0].at as string);
    const cutoff = new Date(now.getTime() - policy.retentionDays * 86400000);
    const candidates = await tx.select({ id: sessions.id }).from(sessions).where(lt(sessions.expiresAt, cutoff)).orderBy(asc(sessions.expiresAt), asc(sessions.id)).limit(1).for("update", { skipLocked: true });
    if (!apply) return { dryRun: true, eligibleSessions: candidates.length, maxRows: policy.cleanupBatch };
    let remaining = policy.cleanupBatch;
    const removed = { counters: 0, messages: 0, conversations: 0, detachedUsage: 0, detachedUtterances: 0, sessions: 0 };
    const counters = await tx.delete(apiRateBuckets).where(inArray(apiRateBuckets.key,
      tx.select({ key: apiRateBuckets.key }).from(apiRateBuckets).where(lt(apiRateBuckets.expiresAt, now)).orderBy(asc(apiRateBuckets.expiresAt)).limit(Math.min(25, remaining))))
      .returning({ key: apiRateBuckets.key });
    remaining -= removed.counters = counters.length;
    const owner = candidates[0]?.id;
    if (owner && remaining) {
      const rows = await tx.delete(messages).where(inArray(messages.id, tx.select({ id: messages.id }).from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId)).where(eq(conversations.sessionId, owner)).limit(remaining))).returning({ id: messages.id });
      remaining -= removed.messages = rows.length;
      if (remaining) {
        const empty = notExists(tx.select({ id: messages.id }).from(messages).where(eq(messages.conversationId, conversations.id)));
        const rows = await tx.delete(conversations).where(inArray(conversations.id, tx.select({ id: conversations.id }).from(conversations)
          .where(and(eq(conversations.sessionId, owner), empty)).limit(remaining))).returning({ id: conversations.id });
        remaining -= removed.conversations = rows.length;
      }
      if (remaining) {
        const rows = await tx.update(usageReservations).set({ sessionId: null }).where(inArray(usageReservations.id,
          tx.select({ id: usageReservations.id }).from(usageReservations).where(eq(usageReservations.sessionId, owner)).limit(remaining))).returning({ id: usageReservations.id });
        remaining -= removed.detachedUsage = rows.length;
      }
      if (remaining) {
        const rows = await tx.update(usageUtterances).set({ sessionId: null }).where(inArray(usageUtterances.id,
          tx.select({ id: usageUtterances.id }).from(usageUtterances).where(eq(usageUtterances.sessionId, owner)).limit(remaining))).returning({ id: usageUtterances.id });
        remaining -= removed.detachedUtterances = rows.length;
      }
      if (remaining) {
        const rows = await tx.delete(sessions).where(and(eq(sessions.id, owner), lt(sessions.expiresAt, cutoff),
          notExists(tx.select({ id: conversations.id }).from(conversations).where(eq(conversations.sessionId, owner))),
          notExists(tx.select({ id: usageReservations.id }).from(usageReservations).where(eq(usageReservations.sessionId, owner))),
          notExists(tx.select({ id: usageUtterances.id }).from(usageUtterances).where(eq(usageUtterances.sessionId, owner))),
          notExists(tx.select({ id: streamRequests.id }).from(streamRequests).where(eq(streamRequests.sessionId, owner))))).returning({ id: sessions.id });
        removed.sessions = rows.length;
      }
    }
    return { dryRun: false, maxRows: policy.cleanupBatch, removed };
  });
}
