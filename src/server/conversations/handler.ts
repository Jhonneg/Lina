import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createSessionService, sessionCookieSettings } from "../sessions";
import { createConversationRepository } from "./repository";
import { identifier, queryPage, StorageInputError, STORAGE_LIMITS, titleInput } from "./validation";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
function fail(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status, headers });
}
function safeFailure(error: unknown) {
  return error instanceof StorageInputError ? fail(error.status, error.code, error.message)
    : fail(503, "STORAGE_UNAVAILABLE", "Conversation storage is unavailable. Please try again later.");
}
async function readCreate(request: NextRequest): Promise<{ title: string | null }> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json" ||
      ![null, "identity"].includes(request.headers.get("content-encoding"))) {
    throw new StorageInputError("Use uncompressed application/json.", 415, "UNSUPPORTED_MEDIA_TYPE");
  }
  const length = request.headers.get("content-length");
  if (length !== null && !/^\d+$/.test(length)) throw new StorageInputError();
  if (length !== null && Number(length) > STORAGE_LIMITS.bodyBytes) throw new StorageInputError("Request body is too large.", 413, "PAYLOAD_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) throw new StorageInputError("Provide a JSON object.");
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > STORAGE_LIMITS.bodyBytes) throw new StorageInputError("Request body is too large.", 413, "PAYLOAD_TOO_LARGE");
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (signal.aborted) throw new StorageInputError("Request was cancelled or timed out.", 408, "REQUEST_ABORTED");
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel(); reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new StorageInputError("Provide valid UTF-8 JSON."); }
  return { title: titleInput(parsed) };
}

export function createConversationHandlers({ repository = createConversationRepository(), service = createSessionService() }: {
  repository?: Pick<ReturnType<typeof createConversationRepository>, "create" | "list" | "get">;
  service?: Pick<ReturnType<typeof createSessionService>, "getExistingSession">;
} = {}) {
  const resolve = (request: NextRequest) => service.getExistingSession(request.cookies.get(sessionCookieSettings().name)?.value);
  return {
    async create(request: NextRequest) {
      if (request.headers.get("origin") !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") {
        return fail(403, "FORBIDDEN_ORIGIN", "A same-origin request is required.");
      }
      try {
        const session = await resolve(request);
        if (!session) return fail(401, "SESSION_REQUIRED", "A valid session is required.");
        if (new URL(request.url).search) throw new StorageInputError("Unsupported query parameters.");
        const conversation = await repository.create(session.id, await readCreate(request));
        if (!conversation) return fail(401, "SESSION_REQUIRED", "A valid session is required.");
        return NextResponse.json({ ok: true, conversation }, { status: 201, headers });
      } catch (error) { return safeFailure(error); }
    },
    async list(request: NextRequest) {
      try {
        const session = await resolve(request);
        if (!session) return fail(401, "SESSION_REQUIRED", "A valid session is required.");
        const result = await repository.list(session.id, queryPage(new URL(request.url).searchParams));
        return NextResponse.json({ ok: true, conversations: result.items, pagination: result.pagination }, { headers });
      } catch (error) { return safeFailure(error); }
    },
    async get(request: NextRequest, context: { params: Promise<{ id: string }> }) {
      try {
        const session = await resolve(request);
        if (!session) return fail(401, "SESSION_REQUIRED", "A valid session is required.");
        const id = identifier((await context.params).id);
        const result = await repository.get(session.id, id, queryPage(new URL(request.url).searchParams));
        if (!result) return fail(404, "NOT_FOUND", "Conversation not found.");
        return NextResponse.json({ ok: true, ...result }, { headers });
      } catch (error) { return safeFailure(error); }
    },
  };
}
