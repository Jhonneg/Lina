import "server-only";
import { createModelAdapter } from "./ai";
import { ModelError, type StreamingModelAdapter } from "./ai/model-adapter";
import { REQUEST_TIMEOUT_MS } from "./chat-handler";
import { readChatRequest, RequestError, validateHeaders } from "./chat-request";

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

export function createChatStreamHandler({ getAdapter = createModelAdapter, timeoutMs = REQUEST_TIMEOUT_MS }: {
  getAdapter?: () => Pick<StreamingModelAdapter, "stream">;
  timeoutMs?: number;
} = {}) {
  return async function POST(request: Request): Promise<Response> {
    const deadline = new AbortController();
    const lifetime = new AbortController();
    const signal = AbortSignal.any([request.signal, deadline.signal, lifetime.signal]);
    const timer = setTimeout(() => deadline.abort(new DOMException("Timed out", "TimeoutError")), timeoutMs);
    try {
      validateHeaders(request);
      const messages = await readChatRequest(request, signal);
      signal.throwIfAborted();
      const adapter = getAdapter();
      const iterator = adapter.stream(messages, signal)[Symbol.asyncIterator]();
      const encoder = new TextEncoder();
      let closed = false;
      let bytes = 0;
      let hasText = false;
      let controller: ReadableStreamDefaultController<Uint8Array>;

      function emit(event: "delta" | "done" | "error", data: object) {
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

      function finish(error?: unknown) {
        if (closed) return;
        closed = true;
        if (error !== undefined) {
          const { code, message } = safeError(error, request, deadline.signal);
          emit("error", { code, message });
        } else emit("done", { finishReason: "completed" });
        controller.close();
        cleanup();
      }

      function aborted() {
        if (request.signal.aborted) {
          if (closed) return;
          closed = true;
          controller.close();
          cleanup();
        } else finish(signal.reason);
      }

      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
        },
        async pull() {
          try {
            // Demand-driven reads keep slow consumers from building a text queue.
            const next = await iterator.next();
            if (closed) return;
            if (next.done) {
              if (!hasText) throw new ModelError("upstream");
              finish();
              return;
            }
            if (typeof next.value !== "string") throw new ModelError("upstream");
            bytes += encoder.encode(next.value).byteLength;
            if (bytes > MAX_STREAM_OUTPUT_BYTES) throw new ModelError("upstream");
            hasText ||= Boolean(next.value.trim());
            emit("delta", { text: next.value });
          } catch (error) {
            finish(error ?? new ModelError("upstream"));
          }
        },
        cancel() {
          if (closed) return;
          closed = true;
          cleanup();
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
      const { status, code, message } = safeError(error, request, deadline.signal);
      return Response.json({ ok: false, error: { code, message } }, {
        status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
  };
}
