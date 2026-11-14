import type { Message } from "./chat-types";
import type { StreamMetadata, ContextMessage } from "./chat-stream";

// Mirror the server's input contract without importing server-only code.
const LIMITS = { messages: 20, messageChars: 4000, totalChars: 12000, bodyBytes: 32 * 1024 };
export const MAX_MESSAGE_CHARS = LIMITS.messageChars;

/** Most recent bounded context; never mutate displayed history or truncate a new prompt. */
export function conversationContext(messages: readonly Message[]): ContextMessage[] {
  const context: ContextMessage[] = [];
  let chars = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if ((message.role === "assistant" && message.status !== undefined && message.status !== "complete") || !message.content.trim()) continue;
    let content = message.content.trim().slice(0, LIMITS.messageChars);
    // Do not split a surrogate pair when bounding a previous assistant response.
    if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1);
    if (context.length === LIMITS.messages || chars + content.length > LIMITS.totalChars) break;
    const candidate = [{ role: message.role, content }, ...context];
    if (new TextEncoder().encode(JSON.stringify({ messages: candidate })).byteLength > LIMITS.bodyBytes - 256) break;
    context.unshift({ role: message.role, content });
    chars += content.length;
  }
  return context;
}

export type ChatState = {
  messages: Message[];
  phase: "idle" | "thinking" | "talking";
  requestId: string | null;
  retryContext: ContextMessage[];
  error: string | null;
  conversationId: string | null;
  assistantId: string | null;
  userId: string | null;
  replayText: string | null;
};
export const INITIAL_CHAT: ChatState = { messages: [], phase: "idle", requestId: null, retryContext: [], error: null, conversationId: null, assistantId: null, userId: null, replayText: null };
export type ChatAction =
  | { type: "start"; requestId: string; context: ContextMessage[]; user?: Message; userId?: string; assistantId?: string }
  | { type: "metadata"; requestId: string; metadata: StreamMetadata }
  | { type: "restore"; messages: Message[]; conversationId: string | null; error?: string | null }
  | { type: "reconcile"; requestId: string; messages: Message[]; conversationId: string }
  | { type: "settle"; requestId: string }
  | { type: "delta"; requestId: string; text: string }
  | { type: "finish"; requestId: string; outcome: "complete" | "interrupted" | "failed"; error?: string }
  | { type: "reset" };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === "reset") return INITIAL_CHAT;
  if (action.type === "restore") return { ...INITIAL_CHAT, messages: action.messages, conversationId: action.conversationId, error: action.error ?? null };
  if (action.type === "start") {
    if (state.requestId) return state;
    return { ...state, messages: action.user ? [...state.messages, action.user] : state.messages,
      phase: "thinking", requestId: action.requestId, retryContext: action.context, error: null,
      userId: action.user?.id ?? action.userId ?? null, assistantId: action.assistantId ?? action.requestId, replayText: null };
  }
  // Ignore late network callbacks after Stop, New Chat, or a newer request.
  if (state.requestId !== action.requestId) return state;
  if (action.type === "settle") return { ...state, phase: "idle" };
  if (action.type === "reconcile") return { ...state, messages: action.messages, conversationId: action.conversationId, replayText: null };
  if (action.type === "metadata") {
    const metadata = action.metadata;
    const seen = new Set<string>();
    const messages = state.messages.map(message => {
      if (message.id === state.userId) return { ...message, id: metadata.userMessageId };
      if (message.id === state.assistantId) return { ...message, id: metadata.assistantMessageId };
      return message;
    }).filter(message => { if (seen.has(message.id)) return false; seen.add(message.id); return true; });
    if (!messages.some(message => message.id === metadata.userMessageId)) {
      const content = state.retryContext.at(-1)?.content;
      if (content) messages.push({ id: metadata.userMessageId, role: "user", content, status: "complete" });
    }
    return { ...state, messages, conversationId: metadata.conversationId, userId: metadata.userMessageId,
      assistantId: metadata.assistantMessageId, replayText: metadata.replayed ? "" : null };
  }
  if (action.type === "delta") {
    if (!action.text) return state;
    const id = state.assistantId ?? action.requestId;
    const existing = state.messages.find(message => message.id === id);
    const replayText = state.replayText === null ? null : state.replayText + action.text;
    const content = replayText === null ? (existing?.content ?? "") + action.text
      : existing?.content.startsWith(replayText) ? existing.content : replayText;
    const message: Message = { id, role: "assistant", content, status: "streaming" };
    const messages = existing ? state.messages.map(item => item.id === id ? message : item) : [...state.messages, message];
    return { ...state, messages, replayText, phase: "talking" };
  }
  return { ...state, phase: "idle", requestId: null, error: action.error ?? null,
    messages: state.messages.map((message) => message.id === state.assistantId ? { ...message, status: action.outcome,
      ...(action.outcome === "complete" && state.replayText !== null ? { content: state.replayText } : {}) } : message) };
}
