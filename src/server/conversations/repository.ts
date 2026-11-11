import "server-only";
import { and, asc, desc, eq, exists, gt, sql } from "drizzle-orm";
import { getDatabase } from "../db";
import { conversations, messages, sessions } from "../db/schema";
import { identifier, messageInput, messagePatch, pageInput, STORAGE_LIMITS, titleInput, type Page } from "./validation";

const conversationFields = { id: conversations.id, title: conversations.title, createdAt: conversations.createdAt, updatedAt: conversations.updatedAt };
const messageFields = { id: messages.id, conversationId: messages.conversationId, role: messages.role, content: messages.content, status: messages.status, createdAt: messages.createdAt };
function owned(sessionId: string, conversationId?: string) {
  return and(eq(conversations.sessionId, sessionId), conversationId ? eq(conversations.id, conversationId) : undefined);
}
function pageResult<T>(rows: T[], page: Page) {
  const next = page.offset + page.limit;
  return { items: rows.slice(0, page.limit), pagination: { ...page,
    nextOffset: rows.length > page.limit && next <= STORAGE_LIMITS.offset ? next : null } };
}

type RepositoryDatabase = Pick<ReturnType<typeof getDatabase>, "select" | "insert" | "update" | "transaction">;
export function createConversationRepository(database: () => RepositoryDatabase = getDatabase) {
  return {
    async create(sessionId: string, input: unknown = {}) {
      sessionId = identifier(sessionId);
      const title = titleInput(input);
      // Insert only for an existing, unexpired owner; UUID/timestamps are DB-generated.
      const db = database();
      const [row] = await db.insert(conversations).select(db.select({
        id: sql<string>`gen_random_uuid()`.as("id"), sessionId: sessions.id, title: sql<string | null>`${title}::text`.as("title"),
        createdAt: sql<Date>`now()`.as("created_at"), updatedAt: sql<Date>`now()`.as("updated_at"),
      }).from(sessions).where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, sql`now()`)))).returning(conversationFields);
      return row ?? null;
    },
    async list(sessionId: string, pagination: Page = { limit: 20, offset: 0 }) {
      sessionId = identifier(sessionId);
      const page = pageInput(pagination);
      const rows = await database().select(conversationFields).from(conversations).where(owned(sessionId))
        .orderBy(desc(conversations.createdAt), desc(conversations.id)).limit(page.limit + 1).offset(page.offset);
      return pageResult(rows, page);
    },
    async get(sessionId: string, conversationId: string, pagination: Page = { limit: 20, offset: 0 }) {
      sessionId = identifier(sessionId); conversationId = identifier(conversationId);
      const page = pageInput(pagination), db = database();
      const [conversation] = await db.select(conversationFields).from(conversations).where(owned(sessionId, conversationId)).limit(1);
      if (!conversation) return null;
      const rows = await db.select(messageFields).from(messages)
        .innerJoin(conversations, eq(messages.conversationId, conversations.id)).where(owned(sessionId, conversationId))
        .orderBy(asc(messages.createdAt), asc(messages.id)).limit(page.limit + 1).offset(page.offset);
      const result = pageResult(rows, page);
      return { conversation, messages: result.items, pagination: result.pagination };
    },
    async appendMessage(sessionId: string, conversationId: string, input: unknown) {
      sessionId = identifier(sessionId); conversationId = identifier(conversationId);
      const message = messageInput(input);
      return database().transaction(async tx => {
        // INSERT ... SELECT makes ownership part of the write itself.
        const [row] = await tx.insert(messages).select(tx.select({
          id: sql<string>`gen_random_uuid()`.as("id"), conversationId: conversations.id,
          role: sql<typeof message.role>`${message.role}::message_role`.as("role"), content: sql<string>`${message.content}::text`.as("content"),
          status: sql<typeof message.status>`${message.status}::message_status`.as("status"), createdAt: sql<Date>`now()`.as("created_at"),
        }).from(conversations).where(owned(sessionId, conversationId))).returning(messageFields);
        if (!row) return null;
        await tx.update(conversations).set({ updatedAt: sql`greatest(${conversations.updatedAt}, clock_timestamp())` }).where(owned(sessionId, conversationId));
        return row;
      });
    },
    async updateMessage(sessionId: string, conversationId: string, messageId: string, input: unknown) {
      sessionId = identifier(sessionId); conversationId = identifier(conversationId); messageId = identifier(messageId);
      const patch = messagePatch(input);
      return database().transaction(async tx => {
        const ownership = tx.select({ id: conversations.id }).from(conversations).where(owned(sessionId, conversationId));
        const [row] = await tx.update(messages).set(patch).where(and(eq(messages.id, messageId),
          eq(messages.conversationId, conversationId), exists(ownership))).returning(messageFields);
        if (!row) return null;
        await tx.update(conversations).set({ updatedAt: sql`greatest(${conversations.updatedAt}, clock_timestamp())` }).where(owned(sessionId, conversationId));
        return row;
      });
    },
  };
}
