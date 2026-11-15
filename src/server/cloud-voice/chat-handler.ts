import "server-only";
import { NextRequest } from "next/server";
import { APPROVED_VOICE_PRESET } from "../../lib/cloud-voice/approved-preset";
import { billingSession } from "../usage/request";
import { createUsageService, type UsageLease } from "../usage/service";
import { UsageError } from "../usage/policy";
import { createSessionService } from "../sessions";
import { readChatBody, validateHeaders, RequestError } from "../chat-request";
import { CLOUD_LIMITS, createCloudVoiceHandler } from "./handler";
import { CLOUD_MODEL, narrationResponse } from "./realtime";

type RelayOptions = NonNullable<Parameters<typeof createCloudVoiceHandler>[0]>;
const headers = { "Cache-Control": "no-store, no-transform", "X-Content-Type-Options": "nosniff" };
const fail = (status: number, code: string, message: string, retryAfter?: number) => Response.json({ ok: false, error: { code, message } }, { status, headers: { ...headers, ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) } });
export function createChatVoiceHandler({ service = createSessionService(), relay, development = () => process.env.NODE_ENV === "development", usage = createUsageService() }: {
  service?: Pick<ReturnType<typeof createSessionService>, "getExistingSession">; relay?: (request: Request, limits: RelayOptions) => Promise<Response>; development?: () => boolean; usage?: ReturnType<typeof createUsageService>;
} = {}) {
  return async (request: NextRequest) => {
    if (!development()) return fail(404, "NOT_FOUND", "Cloud voice is unavailable.");
    let lease: UsageLease | undefined, streaming = false;
    let bytes = 0, started = 0;
    try {
      validateHeaders(request);
      const session = await billingSession(request, service);
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
      const body = await readChatBody(request, signal);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError(400, "INVALID_REQUEST", "Provide text and a request ID.");
      const { text, requestId, segment } = body as Record<string, unknown>;
      if (Object.keys(body).some(key => !["text", "requestId", "segment"].includes(key)) || typeof text !== "string" || !text.trim() || text.length > CLOUD_LIMITS.textChars || typeof requestId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId)) throw new RequestError(400, "INVALID_REQUEST", "Provide 1–800 characters and a valid request UUID.");
      let index = 0, final = true;
      if (segment !== undefined) {
        if (!segment || typeof segment !== "object" || Array.isArray(segment) || Object.keys(segment).some(key => !["index", "final"].includes(key))) throw new RequestError(400, "INVALID_REQUEST", "Invalid speech segment.");
        const item = segment as Record<string, unknown>;
        if (!Number.isInteger(item.index) || Number(item.index) < 0 || Number(item.index) > 2 || typeof item.final !== "boolean") throw new RequestError(400, "INVALID_REQUEST", "Provide an ordered segment index (0–2) and final flag.");
        index = Number(item.index); final = item.final;
      }
      signal.throwIfAborted();
      lease = await usage.reserve({ request, sessionId: session.id, requestId, kind: "speech", model: CLOUD_MODEL,
        source: JSON.stringify(narrationResponse(text, APPROVED_VOICE_PRESET.voice, APPROVED_VOICE_PRESET.delivery)),
        segment: { index, final, progressive: segment !== undefined, chars: text.length } });
      started = performance.now();
      const limits: RelayOptions = { allowDelivery: true, usageLease: lease, durationMs: CLOUD_LIMITS.durationMs - lease.generationMs,
        audioByteLimit: CLOUD_LIMITS.audioBytes - lease.audioBytes, onAudio: size => { bytes += size; } };
      const forwarded = new Headers(request.headers); forwarded.delete("content-length");
      const input = new Request(request.url, { method: "POST", headers: forwarded, signal: request.signal,
        body: JSON.stringify({ text, voice: APPROVED_VOICE_PRESET.voice, delivery: APPROVED_VOICE_PRESET.delivery, confirmed: true }) });
      const response = relay ? await relay(input, limits) : await createCloudVoiceHandler(limits)(input);
      if (!response.ok || !response.body) return response;
      const reader = response.body.getReader(), receipt = lease;
      streaming = true;
      const finish = (completed: boolean) => receipt.finish(undefined, { completed, generationMs: performance.now() - started, audioBytes: bytes });
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) { await finish(true); reader.releaseLock(); controller.close(); }
            else controller.enqueue(next.value);
          } catch {
            void reader.cancel().catch(() => {}); try { await finish(false); } catch { /* Reservation remains charged. */ }
            reader.releaseLock(); controller.error(Error("Cloud audio interrupted."));
          }
        },
        async cancel() { try { await reader.cancel(); } finally { reader.releaseLock(); await finish(false); } },
      }), { status: response.status, headers: response.headers });
    } catch (error) {
      if (error instanceof UsageError) return fail(error.status, error.code, error.message, error.retryAfter);
      return error instanceof RequestError ? fail(error.status, error.code, error.message) : fail(503, "VOICE_UNAVAILABLE", "Cloud speech is unavailable. Please try again later.", 30);
    } finally {
      if (!streaming && lease) await lease.finish(undefined, { completed: false, generationMs: performance.now() - started, audioBytes: bytes }).catch(() => {});
    }
  };
}
