import "server-only";
import { NextRequest } from "next/server";
import { readStreamRequest } from "./persisted-stream-request";
import { createSessionService, sessionCookieSettings } from "./sessions";
import { createStreamPersistence, type StreamClaim } from "./stream-persistence";
import { createModelAdapter } from "./ai";
import { ModelError, type StreamingModelAdapter } from "./ai/model-adapter";
import { REQUEST_TIMEOUT_MS } from "./chat-handler";
import { RequestError, validateHeaders } from "./chat-request";

export const MAX_STREAM_OUTPUT_BYTES = 16_000;

function safeError(error: unknown, request: Request, deadline: AbortSignal) {
  if (error instanceof RequestError) return { status: error.status, code: error.code, message: error.message };
  if (deadline.aborted || (error instanceof ModelError && error.kind === "timeout")) {
    return { status: 504, code: "AI_TIMEOUT", message: "The request timed out. Please try again." };
  }
  if (request.signal.aborted) return { status: 408, code: "REQUEST_ABORTED", message: "The request was cancelled." };
  if (error instanceof ModelError && error.kind === "configuration") {
    return { status: 503, code: "AI_NOT_CONFIGURED", message: "The AI service is not configured." };
  }
  if (error instanceof ModelError) {
    return { status: 502, code: "AI_UNAVAILABLE", message: "Unable to generate a reply. Please try again later." };
  }
  return { status: 500, code: "INTERNAL_ERROR", message: "Unable to process the request." };
}

export function createChatStreamHandler({ getAdapter = createModelAdapter, timeoutMs = REQUEST_TIMEOUT_MS,
  getPersistence = createStreamPersistence, sessionService = createSessionService() }: {
  getAdapter?: () => Pick<StreamingModelAdapter, "stream">;
  timeoutMs?: number;
  getPersistence?: typeof createStreamPersistence;
  sessionService?: Pick<ReturnType<typeof createSessionService>, "getExistingSession">;
} = {}) {
  return async function POST(request: Request): Promise<Response> {
    const deadline = new AbortController();
    const lifetime = new AbortController();
    const signal = AbortSignal.any([request.signal, deadline.signal, lifetime.signal]);
    const timer = setTimeout(() => deadline.abort(new DOMException("Timed out", "TimeoutError")), timeoutMs);
    let persistence: ReturnType<typeof createStreamPersistence> | undefined;
    let receipt: StreamClaim | undefined;
    try {
      validateHeaders(request);
      const input = await readStreamRequest(request, signal);
      signal.throwIfAborted();
      if (input.mode === "persisted") {
        if (request.headers.get("origin") !== new URL(request.url).origin) throw new RequestError(403, "FORBIDDEN_ORIGIN", "A same-origin request is required.");
        const cookies = new NextRequest(request.url, { headers: request.headers }).cookies;
        let session;
        try { session = await sessionService.getExistingSession(cookies.get(sessionCookieSettings().name)?.value); }
        catch { throw new RequestError(503, "PERSISTENCE_UNAVAILABLE", "Conversation storage is unavailable. Please try again later."); }
        if (!session) throw new RequestError(401, "SESSION_REQUIRED", "A valid session is required.");
        persistence = getPersistence();
        receipt = await persistence.begin(session.id, input);
      }
      signal.throwIfAborted();
      const replay = receipt && !receipt.isNew ? receipt : undefined;
      const source = replay ? (async function* () {
        if (replay.content) yield replay.content;
        if (replay.state !== "completed") throw new RequestError(409, replay.state === "interrupted" ? "REQUEST_INTERRUPTED" : "REQUEST_FAILED", "This submission did not complete. Its saved result has been replayed.");
      })() : getAdapter().stream(input.messages, signal);
      const iterator = source[Symbol.asyncIterator]();
      const encoder = new TextEncoder();
      let closed = false;
      let ending = false;
      let transportGone = false;
      let finalizing: Promise<void> | undefined;
      let text = "";
      let bytes = 0;
      let hasText = false;
      let controller: ReadableStreamDefaultController<Uint8Array>;

      function emit(event: "metadata" | "delta" | "done" | "error", data: object) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      function cleanup() {
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        lifetime.abort();
        // Abort first to release a pending next(), then close the iterator.
        // Do not let an uncooperative provider delay response cancellation.
        try { void Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* Already closed. */ }
      }

      function finish(error?: unknown, cancelled = false): Promise<void> {
        if (finalizing) return finalizing;
        ending = true;
        const status = cancelled || request.signal.aborted ? "interrupted" : error !== undefined ? "failed" : "completed";
        cleanup();
        finalizing = (async () => {
          let failure = error;
          if (persistence && receipt) {
            try { await persistence.finish(receipt, text, status); }
            catch { failure = new RequestError(503, "PERSISTENCE_UNAVAILABLE", "Unable to save the response. Retry using the same request ID."); }
          }
          if (!transportGone && !request.signal.aborted) {
            if (failure !== undefined) {
              const { code, message } = safeError(failure, request, deadline.signal);
              emit("error", { code, message });
            } else emit("done", { finishReason: "completed", ...(receipt ? { saved: true } : {}) });
          }
          if (!closed) { controller.close(); closed = true; }
        })();
        return finalizing;
      }

      function aborted() {
        if (request.signal.aborted) {
          transportGone = true;
          if (!closed) { controller.close(); closed = true; }
          void finish(signal.reason, true);
        } else void finish(signal.reason);
      }

      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
          else if (receipt) emit("metadata", { requestId: receipt.requestId, conversationId: receipt.conversationId,
            userMessageId: receipt.userMessageId, assistantMessageId: receipt.assistantMessageId, replayed: !receipt.isNew });
        },
        async pull() {
          try {
            // Demand-driven reads keep slow consumers from building a text queue.
            if (ending) return;
            const next = await iterator.next();
            if (ending) return;
            if (next.done) {
              if (!hasText) throw new ModelError("upstream");
              await finish();
              return;
            }
            if (typeof next.value !== "string") throw new ModelError("upstream");
            bytes += encoder.encode(next.value).byteLength;
            if (bytes > MAX_STREAM_OUTPUT_BYTES) throw new ModelError("upstream");
            text += next.value;
            hasText ||= Boolean(next.value.trim());
            emit("delta", { text: next.value });
          } catch (error) {
            if (!ending) await finish(error ?? new ModelError("upstream"));
          }
        },
        cancel() {
          transportGone = true;
          closed = true;
          return finish(undefined, true);
        },
      }, { highWaterMark: 0 });

      return new Response(body, { headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Content-Type-Options": "nosniff",
        "X-Accel-Buffering": "no",
      } });
    } catch (error) {
      clearTimeout(timer);
      lifetime.abort();
      if (persistence && receipt?.isNew) {
        try { await persistence.finish(receipt, "", request.signal.aborted ? "interrupted" : "failed"); }
        catch { error = new RequestError(503, "PERSISTENCE_UNAVAILABLE", "Unable to save the response. Retry using the same request ID."); }
      }
      const { status, code, message } = safeError(error, request, deadline.signal);
      return Response.json({ ok: false, error: { code, message } }, {
        status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
  };
}
