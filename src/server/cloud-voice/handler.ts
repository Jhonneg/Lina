import "server-only";
import { createUsageService, type UsageLease } from "../usage/service";
import { billingSession, requestKey } from "../usage/request";
import { UsageError } from "../usage/policy";
import type { TokenUsage } from "../usage/policy";
import type { RealtimeResponseUsage } from "openai/resources/realtime/realtime";
import type { RealtimeServerEvent } from "openai/resources/realtime/realtime";
import { RequestError, readChatBody, validateHeaders } from "../chat-request";
import { CLOUD_MODEL, connectRealtime, estimateCost, narrationResponse } from "./realtime";

export const CLOUD_LIMITS = { textChars: 800, durationMs: 30_000, audioBytes: 24_000 * 2 * 60 } as const;
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const VOICES = ["marin", "shimmer", "coral", "cedar"];
function failure(status: number, code: string, message: string, retryAfter?: number) { return Response.json({ ok: false, error: { code, message } }, { status, headers: { ...headers, ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) } }); }
export function createCloudVoiceHandler({ connect = connectRealtime, development = () => process.env.NODE_ENV === "development", key = () => process.env.OPENAI_API_KEY,
  durationMs = CLOUD_LIMITS.durationMs as number, onFinish = () => {}, allowDelivery = false, onAudio = () => {}, onDone = () => {}, audioByteLimit = CLOUD_LIMITS.audioBytes as number, usageLease }: { connect?: typeof connectRealtime; development?: () => boolean; key?: () => string | undefined; durationMs?: number; onFinish?: () => void; allowDelivery?: boolean; onAudio?: (bytes: number) => void; onDone?: (usage?: RealtimeResponseUsage) => void; usageLease?: UsageLease; audioByteLimit?: number } = {}) {
  let busy = false;
  return async function POST(request: Request) {
    if (!development()) return failure(404, "NOT_FOUND", "Not found.");
    if (busy) return failure(429, "VOICE_BUSY", "Another voice evaluation is active. Stop it or wait for completion.");
    busy = true;
    const abort = new AbortController(), signal = AbortSignal.any([request.signal, abort.signal]);
    const deadline = setTimeout(() => abort.abort(), durationMs);
    const release = () => { clearTimeout(deadline); busy = false; onFinish(); };
    let text: string, voice: string, delivery: string | undefined, lease = usageLease;
    try {
      validateHeaders(request);
      if (request.headers.get("origin") !== new URL(request.url).origin) throw new RequestError(403, "FORBIDDEN_ORIGIN", "A same-origin request is required.");
      const body = await readChatBody(request, signal);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError(400, "INVALID_REQUEST", "Provide text, voice and explicit confirmation.");
      const value = body as Record<string, unknown>;
      if (Object.keys(value).some(name => !["text", "voice", "confirmed", ...(allowDelivery ? ["delivery"] : [])].includes(name)) || value.confirmed !== true || typeof value.text !== "string" || !value.text.trim() || value.text.length > CLOUD_LIMITS.textChars || typeof value.voice !== "string" || !VOICES.includes(value.voice)) {
        throw new RequestError(400, "INVALID_REQUEST", "Confirm one billable request, select a supported voice and provide 1–800 characters.");
      }
      if (value.delivery !== undefined && (typeof value.delivery !== "string" || value.delivery.length > 1200)) throw new RequestError(400, "INVALID_REQUEST", "Delivery instructions must contain at most 1,200 characters.");
      text = value.text; voice = value.voice; delivery = allowDelivery ? value.delivery as string | undefined : undefined;
      if (!key()?.trim()) { release(); return failure(503, "VOICE_NOT_CONFIGURED", "Set the server-side OPENAI_API_KEY to evaluate cloud speech."); }
      if (!lease) {
        const session = await billingSession(request);
        lease = await createUsageService().reserve({ request, sessionId: session.id, requestId: requestKey(request), kind: "speech", model: CLOUD_MODEL,
          source: JSON.stringify(narrationResponse(text, voice, delivery)), segment: { index: 0, final: true, progressive: false, chars: text.length } });
      }
      signal.throwIfAborted();
    } catch (error) {
      try { await lease?.finish(); } catch { /* The maximum reservation remains charged. */ }
      release();
      if (error instanceof UsageError) return failure(error.status, error.code, error.message, error.retryAfter);
      return error instanceof RequestError ? failure(error.status, error.code, error.message) : failure(408, "REQUEST_INTERRUPTED", "The voice request was interrupted.");
    }
    const started = performance.now(), encoder = new TextEncoder();
    let finish: (error?: boolean | UsageError) => Promise<void> = async () => {}, cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let connection: Awaited<ReturnType<typeof connect>> | undefined, settled = false, configured = false, bytes = 0, transcript = "";
        let providerDone = false, rawUsage: RealtimeResponseUsage | undefined, actual: TokenUsage | undefined, finalizing: Promise<void> | undefined;
        const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        const closeConnection = () => {
          if (!connection) return;
          connection.off("event", handle);
          // Leave the SDK's safe error listener installed until transport closure.
          connection.socket.removeEventListener("close", closed);
          try { if (connection.socket.readyState === 1) connection.send({ type: "response.cancel" }); connection.close(); } catch { /* Never expose transport internals. */ }
        };
        finish = (error = false) => {
          if (finalizing) return finalizing;
          settled = true; signal.removeEventListener("abort", interrupted); closeConnection(); clearTimeout(deadline);
          finalizing = (async () => {
            let failure: boolean | UsageError = error;
            try { await lease!.finish(actual, { completed: providerDone && !error, generationMs: performance.now() - started, audioBytes: bytes }); }
            catch { failure = new UsageError(503, "USAGE_UNAVAILABLE", "Usage accounting is temporarily unavailable. Please try again later.", 30); }
            release();
            if (!cancelled) {
              if (!request.signal.aborted) {
                if (failure || !providerDone) send("error", failure instanceof UsageError ? { code: failure.code, message: failure.message, retryAfter: failure.retryAfter } : { code: "VOICE_FAILED", message: "Speech could not complete. Try again or use a shorter passage." });
                else send("done", { generationMs: performance.now() - started, estimatedCostUsd: estimateCost(rawUsage), transcript });
              }
              controller.close();
            }
          })();
          return finalizing;
        };
        const interrupted = () => { void finish(!request.signal.aborted); };
        const closed = () => { void finish(true); };
        const handle = (event: RealtimeServerEvent) => {
          if (settled) return;
          try {
            if (event.type === "session.created") {
              connection!.send({ type: "session.update", session: { type: "realtime", output_modalities: ["audio"], tools: [], audio: { input: { turn_detection: null }, output: { voice, format: { type: "audio/pcm", rate: 24000 } } } } });
            } else if (event.type === "session.updated" && !configured) {
              configured = true; connection!.send(narrationResponse(text, voice, delivery));
            } else if (event.type === "response.output_audio.delta") {
              const chunk = event.delta;
              if (typeof chunk !== "string" || chunk.length > 384_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk) || chunk.length % 4) throw Error();
              const size = Buffer.byteLength(chunk, "base64"); bytes += size;
              if (!size || size % 2 || bytes > Math.min(CLOUD_LIMITS.audioBytes, audioByteLimit)) throw Error();
              onAudio(size); send("audio", { pcm: chunk, sampleRate: 24000 });
            } else if (event.type === "response.output_audio_transcript.delta") {
              transcript = (transcript + event.delta).slice(0, 8000);
            } else if (event.type === "response.done") {
              if (event.response.status !== "completed" || !bytes) throw Error();
              providerDone = true; rawUsage = event.response.usage;
              if (rawUsage?.input_token_details?.text_tokens !== undefined && rawUsage.output_token_details?.text_tokens !== undefined && rawUsage.output_token_details?.audio_tokens !== undefined) actual = { input: rawUsage.input_token_details.text_tokens, cached: rawUsage.input_token_details.cached_tokens_details?.text_tokens ?? 0, output: rawUsage.output_token_details.text_tokens, audio: rawUsage.output_token_details.audio_tokens };
              onDone(rawUsage); void finish();
            }
          } catch { void finish(true); }
        };
        signal.addEventListener("abort", interrupted, { once: true });
        if (signal.aborted) { interrupted(); return; }
        void (async () => { await lease!.start(); signal.throwIfAborted(); return connect(key()!); })().then(value => {
          connection = value;
          if (settled || signal.aborted) { connection.on("error", () => {}); connection.close(); return; }
          connection.on("error", () => { void finish(true); }); connection.on("event", handle);
          connection.socket.addEventListener("close", closed);
          // Session-created is delivered after the WebSocket handshake; no microphone or audio input is sent.
        }).catch(error => finish(error instanceof UsageError ? error : true));

      },
      cancel() { cancelled = true; abort.abort(); return finish(true); },
    });
    return new Response(stream, { headers: { ...headers, "Content-Type": "text/event-stream", "X-Accel-Buffering": "no", "X-Voice-Model": CLOUD_MODEL } });
  };
}
