import "server-only";
import { createModelAdapter } from "./ai";
import { ModelError, type ModelAdapter } from "./ai/model-adapter";
import { readChatRequest, RequestError, validateHeaders } from "./chat-request";

export const REQUEST_TIMEOUT_MS = 25_000;

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

function failure(status: number, code: string, message: string) {
  return json({ ok: false, error: { code, message } }, status);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
    if (signal.aborted) abort();
  });
}

export function createChatHandler({ getAdapter = createModelAdapter, timeoutMs = REQUEST_TIMEOUT_MS }: {
  getAdapter?: () => ModelAdapter;
  timeoutMs?: number;
} = {}) {
  return async function POST(request: Request): Promise<Response> {
    const deadline = new AbortController();
    const signal = AbortSignal.any([request.signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(new DOMException("Timed out", "TimeoutError")), timeoutMs);
    try {
      validateHeaders(request);
      const messages = await readChatRequest(request, signal);
      signal.throwIfAborted();
      const adapter = getAdapter();
      const content = await abortable(adapter.generate(messages, signal), signal);
      if (typeof content !== "string" || !content.trim() || content.length > 16_000) throw new ModelError("upstream");
      return json({ ok: true, message: { role: "assistant", content: content.trim() } });
    } catch (error) {
      if (error instanceof RequestError) return failure(error.status, error.code, error.message);
      if (deadline.signal.aborted || (error instanceof ModelError && error.kind === "timeout")) {
        return failure(504, "AI_TIMEOUT", "The request timed out. Please try again.");
      }
      if (request.signal.aborted) return failure(408, "REQUEST_ABORTED", "The request was cancelled.");
      if (error instanceof ModelError && error.kind === "configuration") {
        return failure(503, "AI_NOT_CONFIGURED", "The AI service is not configured.");
      }
      if (error instanceof ModelError) return failure(502, "AI_UNAVAILABLE", "Unable to generate a reply. Please try again later.");
      return failure(500, "INTERNAL_ERROR", "Unable to process the request.");
    } finally {
      clearTimeout(timer);
    }
  };
}
