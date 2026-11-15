export type VoiceProgress = { phase: "loading" | "generating"; file?: string; percent?: number };
export type GenerationOptions = { signal?: AbortSignal; onProgress?: (progress: VoiceProgress) => void };
/** Providers return encoded, Web Audio-decodable audio. No playback or UI ownership. */
export interface SpeechProvider {
  generate(text: string, options?: GenerationOptions): Promise<ArrayBuffer>;
  dispose(): void;
}
export type VoiceState = "idle" | "loading" | "generating" | "playing" | "error" | "disposed";
export class VoiceError extends Error {
  constructor(readonly code: "unsupported" | "loading" | "generation" | "playback" | "autoplay" | "disposed" | "busy" | "input", message: string) {
    super(message); this.name = "VoiceError";
  }
}
export function validateSpeechText(text: string) {
  if (typeof text !== "string" || !text.trim() || text.length > 4000) throw new VoiceError("input", "Provide between 1 and 4,000 characters of speech text.");
}
export type SynthesisMetrics = { initializationMs: number; inferenceMs: number; audioSeconds: number; rtf: number; reused: boolean };
export type WorkerRequest = { id: number; text: string };
export type WorkerResponse = { id: number } & (
  { kind: "progress"; progress: VoiceProgress } | { kind: "audio"; audio: ArrayBuffer; metrics?: SynthesisMetrics } |
  { kind: "error"; code: "loading" | "generation" }
);
