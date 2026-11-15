"use client";

import { VoiceEngine, type VoiceEngineOptions } from "./engine";
import { createKokoroProvider } from "./kokoro-provider";
import { VoiceError } from "./types";

export function createVoiceEngine(options: Partial<VoiceEngineOptions> = {}) {
  const provider = options.provider ?? createKokoroProvider(() => {
    if (typeof Worker === "undefined") throw new VoiceError("unsupported", "This browser does not support speech workers.");
    return new Worker(new URL("./kokoro.worker.ts", import.meta.url), { type: "module", name: "lain-kokoro" });
  });
  return new VoiceEngine({ ...options, provider });
}
export { VoiceEngine } from "./engine";
export { REFINED_PRESET } from "./refined";
export { VoiceError } from "./types";
export type { SpeechProvider, GenerationOptions, VoiceProgress, VoiceState } from "./types";
