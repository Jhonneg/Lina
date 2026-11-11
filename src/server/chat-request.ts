import "server-only";
import type { ConversationMessage } from "./ai/model-adapter";

export const CHAT_LIMITS = {
  bodyBytes: 32 * 1024,
  messages: 20,
  messageChars: 4_000,
  totalChars: 12_000,
} as const;

export class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "RequestError";
  }
}

function invalid(message: string): never {
  throw new RequestError(400, "INVALID_REQUEST", message);
}

export function validateMessages(body: unknown): ConversationMessage[] {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "messages")) {
    return invalid("Body must contain only a messages array.");
  }
  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > CHAT_LIMITS.messages) {
    return invalid(`Provide between 1 and ${CHAT_LIMITS.messages} messages.`);
  }
  let total = 0;
  return messages.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => key !== "role" && key !== "content")) {
      return invalid("Each message must contain only role and content.");
    }
    const { role, content } = item as Record<string, unknown>;
    if (role !== "user" && role !== "assistant") return invalid("Message roles must be user or assistant.");
    if (typeof content !== "string" || !content.trim() || content.length > CHAT_LIMITS.messageChars) {
      return invalid(`Message content must be non-empty text of at most ${CHAT_LIMITS.messageChars} characters.`);
    }
    total += content.length;
    if (total > CHAT_LIMITS.totalChars) return invalid(`Combined content must not exceed ${CHAT_LIMITS.totalChars} characters.`);
    return { role, content: content.trim() };
  });
}

export function validateHeaders(request: Request) {
  const origin = request.headers.get("origin");
  if ((origin !== null && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new RequestError(403, "FORBIDDEN_ORIGIN", "Cross-origin requests are not allowed.");
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new RequestError(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json.");
  }
  const encoding = request.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") {
    throw new RequestError(415, "UNSUPPORTED_MEDIA_TYPE", "Compressed request bodies are not supported.");
  }
  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^\d+$/.test(length)) invalid("Invalid Content-Length.");
    if (Number(length) > CHAT_LIMITS.bodyBytes) throw tooLarge();
  }
}

function tooLarge() {
  return new RequestError(413, "PAYLOAD_TOO_LARGE", `Request body must not exceed ${CHAT_LIMITS.bodyBytes} bytes.`);
}

export async function readChatRequest(request: Request, signal: AbortSignal): Promise<ConversationMessage[]> {
  return validateMessages(await readChatBody(request, signal));
}

export async function readChatBody(request: Request, signal: AbortSignal): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return invalid("A JSON body is required.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let finished = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) { finished = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > CHAT_LIMITS.bodyBytes) throw tooLarge();
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)); }
  catch { return invalid("Body must be valid UTF-8 JSON."); }
  return parsed;
}
