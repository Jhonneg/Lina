import type { CloudVoiceResult } from "./stream";
export type DryTake = { chunks: readonly string[]; text: string; voice: string; delivery: string; result: CloudVoiceResult; firstAudioMs?: number | null };
/** One successful take, memory only. Failure/cancellation does not overwrite the previous take. */
export class DesignAudioCache {
  private current: DryTake | null = null;
  get take() { return this.current; }
  capture() {
    const chunks: string[] = []; let bytes = 0;
    return {
      append(pcm: string) {
        bytes += pcm.length;
        if (bytes > 4_000_000) throw Error("Dry audio cache exceeded its 60-second limit.");
        chunks.push(pcm);
      },
      commit: (source: Omit<DryTake, "chunks">) => { this.current = { ...source, chunks: chunks.slice() }; return this.current; },
    };
  }
  clear() { this.current = null; }
}
