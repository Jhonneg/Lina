import { REFINED_PRESET } from "./refined";
import { VoiceError, type SynthesisMetrics, type VoiceProgress } from "./types";

export const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
/** Runs only inside the worker. Import and initialization are single-flight and retryable. */
export function createKokoroSynthesis(load = () => import("kokoro-js")) {
  type ModelClass = Awaited<ReturnType<typeof load>>["KokoroTTS"];
  let model: ReturnType<ModelClass["from_pretrained"]> | undefined;
  return async (text: string, progress: (value: VoiceProgress) => void, metrics?: (value: SynthesisMetrics) => void) => {
    const started = performance.now(), reused = !!model;
    progress({ phase: "loading" });
    model ??= load().then(({ KokoroTTS }) => KokoroTTS.from_pretrained(KOKORO_MODEL, {
      dtype: "q8", device: "wasm", progress_callback: event => {
        if (event.status === "progress") progress({ phase: "loading", file: event.file, percent: Number.isFinite(event.progress) ? event.progress : undefined });
      },
    })).catch(() => { model = undefined; throw new VoiceError("loading", "Unable to load the speech model. Check your connection and try again."); });
    const tts = await model;
    const initialized = performance.now();
    progress({ phase: "generating" });
    try {
      const audio = await tts.generate(text, { voice: REFINED_PRESET.voice, speed: REFINED_PRESET.speed });
      const inferenceMs = performance.now() - initialized, audioSeconds = audio.audio.length / audio.sampling_rate;
      metrics?.({ initializationMs: initialized - started, inferenceMs, audioSeconds, rtf: inferenceMs / (audioSeconds * 1000), reused });
      // Preserve the reference WAV conversion/decode path, including PCM quantization.
      return await audio.toBlob().arrayBuffer();
    } catch { throw new VoiceError("generation", "Unable to generate speech. Try a shorter English passage."); }
  };
}
