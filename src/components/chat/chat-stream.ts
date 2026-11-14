export type ContextMessage = { role: "user" | "assistant"; content: string };

export class ChatStreamError extends Error {
  constructor(message: string, readonly code = "STREAM_ERROR", readonly status = 0) { super(message); }
}
export const isUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
export type StreamMetadata = { requestId: string; conversationId: string; userMessageId: string; assistantMessageId: string; replayed: boolean };
export type PersistedOptions = { requestId: string; conversationId?: string; onMetadata: (metadata: StreamMetadata) => void };
export function streamMetadata(value: unknown): StreamMetadata {
  if (!value || typeof value !== "object") throw new ChatStreamError(INVALID);
  const item = value as Record<string, unknown>;
  if (![item.requestId, item.conversationId, item.userMessageId, item.assistantMessageId].every(isUuid) || typeof item.replayed !== "boolean") throw new ChatStreamError(INVALID);
  return { requestId: String(item.requestId), conversationId: String(item.conversationId), userMessageId: String(item.userMessageId),
    assistantMessageId: String(item.assistantMessageId), replayed: item.replayed };
}
export function apiError(value: unknown, status = 0) {
  const code = value && typeof value === "object" && "code" in value && typeof value.code === "string" && /^[A-Z_]{1,64}$/.test(value.code) ? value.code : "REQUEST_FAILED";
  return new ChatStreamError(publicMessage(value), code, status);
}

const INTERRUPTED = "The response was interrupted. Please try again.";
const INVALID = "Unable to read the response. Please try again.";

// The route guarantees safe public messages. Never display raw fetch/parser errors.
function publicMessage(value: unknown): string {
  if (value && typeof value === "object" && "message" in value &&
      typeof value.message === "string" && value.message.trim() && value.message.length <= 300) return value.message;
  return "Unable to generate a reply. Please try again.";
}

/** Read POST SSE incrementally, including split UTF-8, CR/LF lines and frames. */
export async function streamChat(messages: readonly ContextMessage[], signal: AbortSignal,
  onDelta: (text: string) => void, fetchImpl: typeof fetch = fetch, persisted?: PersistedOptions): Promise<void> {
  signal.throwIfAborted();
  const response = await fetchImpl("/api/chat/stream", {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(persisted ? { mode: "persisted", requestId: persisted.requestId,
      ...(persisted.conversationId ? { conversationId: persisted.conversationId } : {}), messages } : { messages }),
    credentials: "same-origin", signal,
  });
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
  }
  if (!response.ok) {
    let body;
    try { body = await response.json(); } catch { /* Non-JSON proxy failure. */ }
    throw apiError(body?.error, response.status);
  }
  if (response.headers.get("content-type")?.split(";", 1)[0].trim() !== "text/event-stream" || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new ChatStreamError(INVALID);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let frameSize = 0;
  let metadataSeen = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let end: number;
      while ((end = buffer.search(/[\r\n]/)) !== -1) {
        // A trailing CR may be half of a CRLF split across reads.
        if (buffer[end] === "\r" && end === buffer.length - 1 && !chunk.done) break;
        const line = buffer.slice(0, end);
        const width = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(end + width);
        frameSize += line.length;
        if (frameSize > 64_000) throw new ChatStreamError(INVALID);
        if (line === "") {
          signal.throwIfAborted();
          const name = event;
          const payload = data.join("\n");
          event = ""; data = []; frameSize = 0;
          if (!["metadata", "delta", "done", "error"].includes(name)) continue;
          let parsed;
          try { parsed = JSON.parse(payload); } catch { throw new ChatStreamError(INVALID); }
          if (!parsed || typeof parsed !== "object") throw new ChatStreamError(INVALID);
          if (name === "error") throw apiError(parsed);
          if (name === "metadata") {
            const metadata = streamMetadata(parsed);
            if (metadataSeen || (persisted && (metadata.requestId !== persisted.requestId ||
                (persisted.conversationId && metadata.conversationId !== persisted.conversationId)))) throw new ChatStreamError(INVALID);
            metadataSeen = true;
            persisted?.onMetadata(metadata);
            continue;
          }
          if (persisted && !metadataSeen) throw new ChatStreamError(INVALID);
          if (name === "done") {
            if (parsed.finishReason !== "completed" || (persisted && parsed.saved !== true)) throw new ChatStreamError(INVALID);
            return;
          }
          if (typeof parsed.text !== "string") throw new ChatStreamError(INVALID);
          if (parsed.text.length > 0) onDelta(parsed.text);
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          let value = colon === -1 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "event") event = value;
          if (field === "data") data.push(value);
        }
      }
      if (buffer.length > 64_000) throw new ChatStreamError(INVALID);
      if (chunk.done) throw new ChatStreamError(INTERRUPTED);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}
