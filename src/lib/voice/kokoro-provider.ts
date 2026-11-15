import { voiceTrace } from "./diagnostics";
import { VoiceError, validateSpeechText, type SpeechProvider, type WorkerResponse } from "./types";

export function createKokoroProvider(createWorker: () => Worker): SpeechProvider {
  let worker: Worker | undefined, disposed = false, serial = 0;
  let active: { fail: (error: Error) => void } | undefined;
  function reset() { if (worker) { voiceTrace("worker-terminated"); worker.terminate(); worker = undefined; } }
  return {
    generate(text, { signal, onProgress } = {}) {
      try {
        validateSpeechText(text); signal?.throwIfAborted();
        if (disposed) throw new VoiceError("disposed", "The speech provider has been disposed.");
        if (active) throw new VoiceError("busy", "Speech generation is already in progress.");
        if (!worker) { worker = createWorker(); voiceTrace("worker-started", { restart: serial > 0 }); }
      } catch (error) { return Promise.reject(error); }
      const current = worker, id = ++serial;
      return new Promise<ArrayBuffer>((resolve, reject) => {
        let settled = false;
        function cleanup() {
          current.removeEventListener("message", message); current.removeEventListener("error", error); current.removeEventListener("messageerror", error);
          signal?.removeEventListener("abort", abort); active = undefined;
        }
        function fail(failure: Error) { if (settled) return; settled = true; cleanup(); reset(); reject(failure); }
        function abort() { voiceTrace("inference-cancelled"); fail(new DOMException("Speech generation cancelled.", "AbortError")); }
        function error() { fail(new VoiceError("generation", "The speech worker failed. Please try again.")); }
        function message(event: MessageEvent<WorkerResponse>) {
          if (event.data.id !== id || settled) return;
          if (event.data.kind === "progress") { try { onProgress?.(event.data.progress); } catch { /* Observer errors do not own the worker. */ } return; }
          if (event.data.kind === "error") { fail(new VoiceError(event.data.code, "Unable to load or generate speech. Please try again.")); return; }
          if (event.data.metrics) voiceTrace("synthesis", event.data.metrics);
          settled = true; cleanup(); resolve(event.data.audio);
        }
        active = { fail };
        current.addEventListener("message", message); current.addEventListener("error", error); current.addEventListener("messageerror", error);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        try { current.postMessage({ id, text }); } catch { error(); }
      });
    },
    dispose() {
      disposed = true;
      active?.fail(new DOMException("Speech provider disposed.", "AbortError")); reset();
    },
  };
}
