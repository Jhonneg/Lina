import "server-only";
import { readChatBody, RequestError, validateMessages } from "./chat-request";
import { identifier } from "./conversations/validation";

export async function readStreamRequest(request: Request, signal: AbortSignal) {
  const body = await readChatBody(request, signal);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError(400, "INVALID_REQUEST", "Provide a JSON object.");
  const input = body as Record<string, unknown>;
  const persisted = input.mode === "persisted";
  if (input.mode !== undefined && input.mode !== "ephemeral" && !persisted) throw new RequestError(400, "INVALID_REQUEST", "Invalid streaming mode.");
  const keys = persisted ? ["mode", "requestId", "conversationId", "messages"] : ["mode", "messages"];
  if (Object.keys(input).some(key => !keys.includes(key))) throw new RequestError(400, "INVALID_REQUEST", "Unsupported streaming fields.");
  const messages = validateMessages({ messages: input.messages });
  if (!persisted) return { mode: "ephemeral" as const, messages };
  try {
    const requestId = identifier(input.requestId);
    const conversationId = input.conversationId === undefined ? undefined : identifier(input.conversationId);
    if (messages.at(-1)?.role !== "user") throw new Error();
    return { mode: "persisted" as const, messages, requestId, conversationId };
  } catch {
    throw new RequestError(400, "INVALID_REQUEST", "Persisted requests require UUID identifiers and a final user message.");
  }
}
export type PersistedStreamInput = Extract<Awaited<ReturnType<typeof readStreamRequest>>, { mode: "persisted" }>;
