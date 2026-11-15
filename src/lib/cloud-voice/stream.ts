export type VoiceSegment = { index: number; final: boolean };
export class CloudVoiceRequestError extends Error {}
export type CloudVoiceResult = { generationMs: number; estimatedCostUsd: number | null; transcript: string };
/** Narrow NDJSON-in-SSE protocol for the session-authorized audio relay. */
export async function streamCloudVoice(text: string, voice: string, signal: AbortSignal, audio: (pcm: string) => void,
  fetchImpl: typeof fetch = fetch, chatRequestId?: string, labDelivery?: string, segment?: VoiceSegment): Promise<CloudVoiceResult> {
  const response = await fetchImpl(chatRequestId ? "/api/voice" : "/api/dev/cloud-voice", { method: "POST", credentials: "same-origin", signal,
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(!chatRequestId ? { "Idempotency-Key": crypto.randomUUID() } : {}) }, body: JSON.stringify(chatRequestId ? { text, requestId: chatRequestId, ...(segment ? { segment } : {}) } : { text, voice, confirmed: true, ...(labDelivery === undefined ? {} : { delivery: labDelivery }) }) });
  if (!response.ok) {
    let value; try { value = await response.json(); } catch { /* Safe default. */ }
    throw new CloudVoiceRequestError(typeof value?.error?.message === "string" && value.error.message.length < 300 ? value.error.message : "Cloud speech is unavailable.");
  }
  if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) throw Error("Invalid audio response.");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let buffer = "", event = "", data: string[] = [], size = 0;
  try {
    while (true) {
      signal.throwIfAborted(); const chunk = await reader.read(); signal.throwIfAborted();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let end: number;
      while ((end = buffer.search(/[\r\n]/)) >= 0) {
        if (buffer[end] === "\r" && end === buffer.length - 1 && !chunk.done) break;
        const line = buffer.slice(0, end), width = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(end + width); size += line.length;
        if (size > 400_000) throw Error("Audio event too large.");
        if (!line) {
          if (data.length) {
            const value = JSON.parse(data.join("\n"));
            if (event === "error") throw new CloudVoiceRequestError(typeof value.message === "string" && value.message.length <= 300 ? value.message : "Speech could not complete. Try again or use a shorter passage.");
            if (event === "audio") {
              if (value.sampleRate !== 24000 || typeof value.pcm !== "string") throw Error("Invalid audio format.");
              audio(value.pcm);
            } else if (event === "done") {
              if (!Number.isFinite(value.generationMs) || value.generationMs < 0 || !(value.estimatedCostUsd === null || (Number.isFinite(value.estimatedCostUsd) && value.estimatedCostUsd >= 0)) || typeof value.transcript !== "string") throw Error("Invalid completion event.");
              return value;
            }
          }
          event = ""; data = []; size = 0;
        } else if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (buffer.length > 400_000) throw Error("Audio event too large.");
      if (chunk.done) throw Error("Audio stream ended before completion.");
    }
  } finally { signal.removeEventListener("abort", cancel); cancel(); reader.releaseLock(); }
}
