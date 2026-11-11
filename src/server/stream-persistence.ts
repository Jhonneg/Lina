import "server-only";
import { createHash } from "node:crypto";
import { and, eq, exists, sql } from "drizzle-orm";
import { getDatabase } from "./db";
import { conversations, messages, streamRequests } from "./db/schema";
import { createConversationRepository } from "./conversations/repository";
import { RequestError } from "./chat-request";
import type { PersistedStreamInput } from "./persisted-stream-request";

type State = typeof streamRequests.$inferSelect.state;
export type StreamClaim = {
  sessionId: string; requestId: string; conversationId: string;
  userMessageId: string; assistantMessageId: string; state: State; content: string; isNew: boolean;
};
type Transaction = Parameters<Parameters<ReturnType<typeof getDatabase>["transaction"]>[0]>[0];
const unavailable = () => new RequestError(503, "PERSISTENCE_UNAVAILABLE", "Unable to save the response. Retry using the same request ID.");
async function lock(tx: Transaction, sessionId: string, requestId: string) {
  await tx.execute(sql`SET LOCAL statement_timeout = '5000'`);
  await tx.execute(sql`SET LOCAL lock_timeout = '4000'`);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${sessionId + ":" + requestId}, 0))`);
}
function owner(sessionId: string, conversationId: string) {
  return and(eq(conversations.id, conversationId), eq(conversations.sessionId, sessionId));
}
async function find(tx: Transaction, sessionId: string, requestId: string) {
  const [row] = await tx.select({ request: streamRequests, content: messages.content }).from(streamRequests)
    .innerJoin(conversations, and(eq(conversations.id, streamRequests.conversationId), eq(conversations.sessionId, sessionId)))
    .innerJoin(messages, and(eq(messages.id, streamRequests.assistantMessageId), eq(messages.conversationId, conversations.id)))
    .where(and(eq(streamRequests.sessionId, sessionId), eq(streamRequests.requestId, requestId))).for("update");
  return row;
}
function claim(row: typeof streamRequests.$inferSelect, content: string, isNew: boolean): StreamClaim {
  return { sessionId: row.sessionId, requestId: row.requestId, conversationId: row.conversationId,
    userMessageId: row.userMessageId, assistantMessageId: row.assistantMessageId, state: row.state, content, isNew };
}
async function save(tx: Transaction, row: typeof streamRequests.$inferSelect, content: string, status: Exclude<State, "running">) {
  const ownership = tx.select({ id: conversations.id }).from(conversations).where(owner(row.sessionId, row.conversationId));
  const [message] = await tx.update(messages).set({ content, status }).where(and(eq(messages.id, row.assistantMessageId),
    eq(messages.conversationId, row.conversationId), eq(messages.role, "assistant"), exists(ownership))).returning({ id: messages.id });
  if (!message) throw unavailable();
  const [saved] = await tx.update(streamRequests).set({ state: status, finishedAt: sql`clock_timestamp()` })
    .where(and(eq(streamRequests.id, row.id), eq(streamRequests.sessionId, row.sessionId),
      eq(streamRequests.state, "running"), exists(ownership))).returning();
  if (!saved) throw unavailable();
  await tx.update(conversations).set({ updatedAt: sql`greatest(${conversations.updatedAt}, clock_timestamp())` })
    .where(owner(row.sessionId, row.conversationId));
  return saved;
}

export function createStreamPersistence() {
  return {
    async begin(sessionId: string, input: PersistedStreamInput): Promise<StreamClaim> {
      const fingerprint = createHash("sha256").update(JSON.stringify({ conversationId: input.conversationId ?? null, messages: input.messages })).digest("hex");
      try {
        return await getDatabase().transaction(async tx => {
          await lock(tx, sessionId, input.requestId);
          if (input.conversationId) {
            const [owned] = await tx.select({ id: conversations.id }).from(conversations).where(owner(sessionId, input.conversationId)).limit(1);
            if (!owned) throw new RequestError(404, "NOT_FOUND", "Conversation not found.");
          }
          const previous = await find(tx, sessionId, input.requestId);
          if (previous) {
            if (previous.request.fingerprint !== fingerprint) throw new RequestError(409, "REQUEST_CONFLICT", "Request ID was already used for a different submission.");
            if (previous.request.state === "running") {
              const stale = await tx.execute(sql`SELECT ${previous.request.staleAt}::timestamptz <= clock_timestamp() AS stale`);
              if (!stale.rows[0].stale) throw new RequestError(409, "REQUEST_IN_PROGRESS", "This submission is already generating a response.");
              // Never take over generation: a late original worker must not race a retry.
              const recovered = await save(tx, previous.request, previous.content, "failed");
              return claim(recovered, previous.content, false);
            }
            return claim(previous.request, previous.content, false);
          }
          const repository = createConversationRepository(() => tx);
          const conversationId = input.conversationId ?? (await repository.create(sessionId))?.id;
          if (!conversationId) throw new RequestError(401, "SESSION_REQUIRED", "A valid session is required.");
          const user = await repository.appendMessage(sessionId, conversationId, input.messages.at(-1)!);
          if (!user) throw new RequestError(404, "NOT_FOUND", "Conversation not found.");
          const [assistant] = await tx.insert(messages).select(tx.select({
            id: sql<string>`gen_random_uuid()`.as("id"), conversationId: conversations.id,
            role: sql<"assistant">`'assistant'::message_role`.as("role"), content: sql<string>`''::text`.as("content"),
            status: sql<"pending">`'pending'::message_status`.as("status"), createdAt: sql<Date>`clock_timestamp()`.as("created_at"),
          }).from(conversations).where(owner(sessionId, conversationId))).returning({ id: messages.id });
          if (!assistant) throw unavailable();
          const [record] = await tx.insert(streamRequests).values({ sessionId, requestId: input.requestId, fingerprint,
            conversationId, userMessageId: user.id, assistantMessageId: assistant.id,
            staleAt: sql`clock_timestamp() + interval '60 seconds'` }).returning();
          return claim(record, "", true);
        });
      } catch (error) { if (error instanceof RequestError) throw error; throw unavailable(); }
    },
    async finish(receipt: StreamClaim, content: string, status: Exclude<State, "running">): Promise<void> {
      if (!receipt.isNew) return;
      try {
        await getDatabase().transaction(async tx => {
          await lock(tx, receipt.sessionId, receipt.requestId);
          const found = await find(tx, receipt.sessionId, receipt.requestId);
          if (!found || found.request.state !== "running" || found.request.assistantMessageId !== receipt.assistantMessageId) throw unavailable();
          await save(tx, found.request, content, status);
        });
      } catch (error) { if (error instanceof RequestError) throw error; throw unavailable(); }
    },
  };
}
