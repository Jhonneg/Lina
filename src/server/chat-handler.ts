import { createUsageService, type UsageLease } from "./usage/service";
import { billingSession, requestKey } from "./usage/request";
import { UsageError } from "./usage/policy";
import { LAIN_PERSONALITY_INSTRUCTIONS } from "./ai/personality";
import "server-only";
import { createModelAdapter } from "./ai";
import { ModelError, type ModelAdapter } from "./ai/model-adapter";
import { readChatRequest, RequestError, validateHeaders } from "./chat-request";

export const REQUEST_TIMEOUT_MS = 25_000;

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

function failure(status: number, code: string, message: string, retryAfter?: number) {
  const response = json({ ok: false, error: { code, message } }, status); if (retryAfter) response.headers.set("Retry-After", String(retryAfter)); return response;
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

export function createChatHandler({ getAdapter = createModelAdapter, timeoutMs = REQUEST_TIMEOUT_MS, usage = createUsageService() }: {
  getAdapter?: () => ModelAdapter;
  timeoutMs?: number; usage?: ReturnType<typeof createUsageService>;
} = {}) {
  return async function POST(request: Request): Promise<Response> {
    const deadline = new AbortController();
    const signal = AbortSignal.any([request.signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(new DOMException("Timed out", "TimeoutError")), timeoutMs);
    let lease: UsageLease | undefined, actual: import("./usage/policy").TokenUsage | undefined;
    try {
      validateHeaders(request);
      const messages = await readChatRequest(request, signal);
      signal.throwIfAborted();
      const adapter = getAdapter();
      if (adapter.billing) {
        const session = await abortable(billingSession(request), signal);
        lease = await usage.reserve({ request, sessionId: session.id, requestId: requestKey(request), kind: "text", model: adapter.billing.model,
          source: JSON.stringify({ instructions: LAIN_PERSONALITY_INSTRUCTIONS, messages }) });
        signal.throwIfAborted(); await lease.start(); signal.throwIfAborted();
      }
      const content = await abortable(adapter.generate(messages, signal, value => { actual = value; }), signal);
      await lease?.finish(actual);
      if (typeof content !== "string" || !content.trim() || content.length > 16_000) throw new ModelError("upstream");
      return json({ ok: true, message: { role: "assistant", content: content.trim() } });
    } catch (error) {
      try { await lease?.finish(actual); } catch { error = new UsageError(503, "USAGE_UNAVAILABLE", "Usage accounting is temporarily unavailable. Please try again later.", 30); }
      if (error instanceof UsageError) return failure(error.status, error.code, error.message, error.retryAfter);
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
