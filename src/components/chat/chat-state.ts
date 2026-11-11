import type { Message } from "./chat-types";
import type { ContextMessage } from "./chat-stream";

// Mirror the server's input contract without importing server-only code.
const LIMITS = { messages: 20, messageChars: 4000, totalChars: 12000, bodyBytes: 32 * 1024 };
export const MAX_MESSAGE_CHARS = LIMITS.messageChars;

/** Most recent bounded context; never mutate displayed history or truncate a new prompt. */
export function conversationContext(messages: readonly Message[]): ContextMessage[] {
  const context: ContextMessage[] = [];
  let chars = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.status === "interrupted" || !message.content.trim()) continue;
    let content = message.content.trim().slice(0, LIMITS.messageChars);
    // Do not split a surrogate pair when bounding a previous assistant response.
    if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1);
    if (context.length === LIMITS.messages || chars + content.length > LIMITS.totalChars) break;
    const candidate = [{ role: message.role, content }, ...context];
    if (new TextEncoder().encode(JSON.stringify({ messages: candidate })).byteLength > LIMITS.bodyBytes) break;
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
};
export const INITIAL_CHAT: ChatState = { messages: [], phase: "idle", requestId: null, retryContext: [], error: null };
export type ChatAction =
  | { type: "start"; requestId: string; context: ContextMessage[]; user?: Message }
  | { type: "delta"; requestId: string; text: string }
  | { type: "finish"; requestId: string; outcome: "complete" | "interrupted"; error?: string }
  | { type: "reset" };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  if (action.type === "reset") return INITIAL_CHAT;
  if (action.type === "start") {
    if (state.requestId) return state;
    return { ...state, messages: action.user ? [...state.messages, action.user] : state.messages,
      phase: "thinking", requestId: action.requestId, retryContext: action.context, error: null };
  }
  // Ignore late network callbacks after Stop, New Chat, or a newer request.
  if (state.requestId !== action.requestId) return state;
  if (action.type === "delta") {
    if (!action.text) return state;
    const existing = state.messages.some(({ id }) => id === action.requestId);
    const messages: Message[] = existing
      ? state.messages.map((message) => message.id === action.requestId ? { ...message, content: message.content + action.text } : message)
      : [...state.messages, { id: action.requestId, role: "assistant", content: action.text, status: "streaming" }];
    return { ...state, messages, phase: "talking" };
  }
  return { ...state, phase: "idle", requestId: null, error: action.error ?? null,
    messages: state.messages.map((message) => message.id === action.requestId ? { ...message, status: action.outcome } : message) };
}
