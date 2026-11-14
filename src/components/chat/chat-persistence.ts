import { apiError, ChatStreamError, isUuid, streamMetadata, type ContextMessage, type StreamMetadata } from "./chat-stream";
import type { Message } from "./chat-types";

export type Submission = {
  requestId: string;
  ownerId: string; // Safe server metadata, used only to detect a changed browser session.
  startedAt: number;
  retryAt?: number;
  conversationId?: string; // Original payload: never replace this with metadata on retry.
  messages: ContextMessage[];
  userId: string;
  metadata?: StreamMetadata;
  partial: string;
};
export const PENDING_KEY = "lain.pending-submission.v1";
export type PendingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const UNAVAILABLE = "Unable to restore this conversation. Try again or start a new chat.";

async function jsonRequest(url: string, options: RequestInit, fetchImpl: typeof fetch) {
  const response = await fetchImpl(url, { ...options, credentials: "same-origin", cache: "no-store" });
  let body;
  try { body = await response.json(); } catch { throw new ChatStreamError(UNAVAILABLE); }
  if (!response.ok) throw apiError(body?.error, response.status);
  if (!body || body.ok !== true) throw new ChatStreamError(UNAVAILABLE);
  return body;
}

/** Shared single-flight initialization survives React Strict Mode effect replay. */
export function createSessionInitializer(fetchImpl: typeof fetch = fetch) {
  let initialized: string | null = null;
  let pending: Promise<string> | undefined;
  return function initialize(force = false): Promise<string> {
    if (pending) return pending;
    if (initialized && !force) return Promise.resolve(initialized);
    pending = (async () => {
      try {
        const body = await jsonRequest("/api/session", { method: "POST", signal: AbortSignal.timeout(10000) }, fetchImpl);
        if (!isUuid(body.session?.id) || typeof body.session.expiresAt !== "string" || !Number.isFinite(Date.parse(body.session.expiresAt))) throw new ChatStreamError("Unable to initialize this browser session. Please try again.");
        initialized = body.session.id;
        return initialized!;
      } catch {
        initialized = null;
        throw new ChatStreamError("Unable to initialize this browser session. Please try again.", "SESSION_INIT_FAILED");
      } finally { pending = undefined; }
    })();
    return pending;
  };
}
export const initializeSession = createSessionInitializer();

export async function restoreConversation(id: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<Message[]> {
  if (!isUuid(id)) throw new ChatStreamError(UNAVAILABLE, "NOT_FOUND", 404);
  const messages = new Map<string, Message>();
  let offset = 0;
  for (let page = 0; page <= 200; page++) {
    signal.throwIfAborted();
    const body = await jsonRequest(`/api/conversations/${id}?limit=50&offset=${offset}`, { method: "GET", signal }, fetchImpl);
    signal.throwIfAborted();
    if (body.conversation?.id !== id || !Array.isArray(body.messages) || body.messages.length > 50 ||
        body.pagination?.limit !== 50 || body.pagination?.offset !== offset) throw new ChatStreamError(UNAVAILABLE);
    for (const item of body.messages) {
      if (!isUuid(item.id) || item.conversationId !== id || !["user", "assistant"].includes(item.role) ||
          typeof item.content !== "string" || item.content.length > 16000 ||
          !["completed", "interrupted", "failed", "pending"].includes(item.status)) throw new ChatStreamError(UNAVAILABLE);
      messages.set(item.id, { id: item.id, role: item.role, content: item.content, status: item.status === "completed" ? "complete" : item.status });
    }
    const next = body.pagination.nextOffset;
    if (next === null) return [...messages.values()];
    if (!Number.isInteger(next) || next !== offset + 50 || next > 10000) throw new ChatStreamError(UNAVAILABLE);
    offset = next;
  }
  throw new ChatStreamError(UNAVAILABLE);
}

export function readPending(storage: PendingStorage | undefined): Submission | null {
  try {
    const text = storage?.getItem(PENDING_KEY);
    if (!text) return null;
    if (text.length > 100000) throw new Error();
    const item = JSON.parse(text);
    if (!isUuid(item.requestId) || !isUuid(item.ownerId) || !Number.isFinite(item.startedAt) || (item.retryAt !== undefined && !Number.isFinite(item.retryAt)) || !isUuid(item.userId) || (item.conversationId !== undefined && !isUuid(item.conversationId)) ||
        !Array.isArray(item.messages) || item.messages.length < 1 || item.messages.length > 20 || typeof item.partial !== "string" || item.partial.length > 16000) throw new Error();
    let chars = 0;
    const messages = item.messages.map((message: ContextMessage) => {
      if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string" ||
          !message.content.trim() || message.content.length > 4000) throw new Error();
      chars += message.content.length;
      return { role: message.role, content: message.content };
    });
    if (chars > 12000 || messages.at(-1)?.role !== "user") throw new Error();
    const metadata = item.metadata ? streamMetadata(item.metadata) : undefined;
    if (metadata && (metadata.requestId !== item.requestId || (item.conversationId && metadata.conversationId !== item.conversationId))) throw new Error();
    const result = { requestId: item.requestId, ownerId: item.ownerId, startedAt: item.startedAt, retryAt: item.retryAt, conversationId: item.conversationId, messages, userId: item.userId, partial: item.partial, metadata };
    if (new TextEncoder().encode(JSON.stringify({ mode: "persisted", requestId: result.requestId, conversationId: result.conversationId, messages })).byteLength > 32768) throw new Error();
    return result;
  } catch { try { storage?.removeItem(PENDING_KEY); } catch { /* Storage is optional. */ } return null; }
}
export function writePending(storage: PendingStorage | undefined, submission: Submission | null) {
  try {
    if (submission) storage?.setItem(PENDING_KEY, JSON.stringify(submission));
    else storage?.removeItem(PENDING_KEY);
  } catch { /* In-memory retry still works when browser storage is unavailable. */ }
}
export function pendingMessages(submission: Submission): Message[] {
  return [
    { id: submission.metadata?.userMessageId ?? submission.userId, role: "user", content: submission.messages.at(-1)!.content, status: "complete" },
    ...(submission.partial ? [{ id: submission.metadata?.assistantMessageId ?? submission.requestId, role: "assistant" as const,
      content: submission.partial, status: "interrupted" as const }] : []),
  ];
}
/** Server owns IDs/status; retain unacknowledged partial text without calling it complete. */
export function reconcileMessages(server: Message[], local: Message[], submission: Submission | null): Message[] {
  const byId = new Map(local.map(message => [message.id, message]));
  const result = server.map(message => {
    const previous = byId.get(message.id);
    if (message.role === "assistant" && message.status !== "complete" && previous &&
        previous.content.startsWith(message.content) && previous.content.length > message.content.length) {
      return { ...message, content: previous.content };
    }
    return message;
  });
  if (submission && (submission.metadata || server.length === 0)) for (const message of pendingMessages(submission)) {
    if (!result.some(item => item.id === message.id)) result.push(message);
  }
  return result;
}
export function savedSubmission(server: Message[], submission: Submission | null): boolean {
  return Boolean(submission?.metadata && server.some(message => message.id === submission.metadata!.assistantMessageId && message.status === "complete"));
}
export function submissionConversation(submission: Submission | null) {
  return submission?.metadata?.conversationId ?? submission?.conversationId ?? null;
}
