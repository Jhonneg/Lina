import { AudioReactivity } from "../../lib/audio/reactivity";
import { DesignVoicePlayer } from "../../lib/cloud-voice/design-player";
import { APPROVED_VOICE_PRESET } from "../../lib/cloud-voice/approved-preset";
import { CloudVoiceRequestError, streamCloudVoice } from "../../lib/cloud-voice/stream";
import { CloudSpeechBuffer } from "./cloud-speech-buffer";
import type { VoiceView } from "./voice-types";
import type { Message } from "./chat-types";

export const INITIAL_CLOUD_VOICE: VoiceView = { enabled: false, permitted: false, preferredEnabled: false, volume: 1,
  state: "idle", messageId: null, progress: "", error: null, notice: null };
type Player = Pick<DesignVoicePlayer, "analyser" | "unlock" | "append" | "finish" | "reset" | "stop" | "setVolume" | "beginSegment" | "endSegment">;
type Options = { createPlayer?: (playing: (value: boolean) => void) => Player; stream?: typeof streamCloudVoice; development?: boolean };
type SpeechJob = { id: string; progressive: boolean; buffer: CloudSpeechBuffer; abort: AbortController; requestId: string; wake?: () => void;
  complete: Promise<void>; resolve: () => void; timer?: ReturnType<typeof setTimeout> };
const KEY = "lain.cloud-voice-preferences.v1";

/** Ordered progressive cloud speech. Activation requires a current-visit playback gesture. */
export class CloudChatVoiceController {
  view: VoiceView = INITIAL_CLOUD_VOICE;
  private player?: Player;
  private operation?: AbortController;
  private job?: SpeechJob;
  private revision = 0;
  private disposed = false;
  private listeners = new Set<() => void>();
  private candidate: { request: string; assistant: string | null } | null = null;
  private suppressed: string | null = null;
  private conversation: string | null | undefined;
  private handled = new Set<string>();
  private readonly createPlayer: NonNullable<Options["createPlayer"]>;
  private readonly stream: typeof streamCloudVoice;
  private readonly development: boolean;
  constructor(readonly audio: { current: AudioReactivity | null }, private readonly storage?: Pick<Storage, "getItem" | "setItem">, options: Options = {}) {
    this.createPlayer = options.createPlayer ?? (playing => new DesignVoicePlayer({ ...APPROVED_VOICE_PRESET.effects }, playing));
    this.stream = options.stream ?? streamCloudVoice;
    this.development = options.development ?? process.env.NODE_ENV === "development";
    try {
      const saved = JSON.parse(storage?.getItem(KEY) ?? "null");
      if (saved?.version === 1) this.view = { ...INITIAL_CLOUD_VOICE, preferredEnabled: saved.enabled === true,
        volume: typeof saved.volume === "number" && Number.isFinite(saved.volume) && saved.volume >= 0 && saved.volume <= 1 ? saved.volume : 1 };
    } catch { /* Preferences never activate cloud speech. */ }
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private publish(patch: Partial<VoiceView>) { if (!this.disposed) { this.view = { ...this.view, ...patch }; for (const listener of this.listeners) listener(); } }
  private save() { try { this.storage?.setItem(KEY, JSON.stringify({ version: 1, enabled: this.view.preferredEnabled, volume: this.view.volume })); } catch { /* Optional. */ } }
  private resetAudio() { this.audio.current?.dispose(); this.audio.current = null; }
  private ensurePlayer() {
    if (!this.player) {
      const player = this.createPlayer(playing => {
        if (this.player !== player || !this.operation || this.operation.signal.aborted || this.disposed) return;
        this.resetAudio();
        if (playing && player.analyser) this.audio.current = new AudioReactivity(player.analyser);
        this.publish({ state: playing ? "playing" : "generating", progress: playing ? "" : "Waiting for cloud audio…" });
      });
      this.player = player; player.setVolume(this.view.volume);
    }
    return this.player;
  }
  async enable() {
    if (this.disposed) return false;
    if (!this.development) { this.publish({ error: "Cloud speech is available only in local development.", state: "error" }); return false; }
    this.stop(); const revision = this.revision;
    this.publish({ state: "activating", error: null });
    try {
      // Same activated context is reused for later automatic playback; no model initialization.
      await this.ensurePlayer().unlock();
      if (this.disposed || revision !== this.revision) return false;
      this.publish({ enabled: true, permitted: true, preferredEnabled: true, state: "idle" }); this.save(); return true;
    } catch {
      if (revision === this.revision) this.publish({ enabled: false, permitted: false, state: "error", error: "Audio could not be enabled. Try again from the voice controls." });
      return false;
    }
  }
  stop() {
    this.suppressed = this.candidate?.request ?? this.suppressed; this.candidate = null;
    const job = this.job; this.job = undefined; if (job) { clearTimeout(job.timer); job.wake?.(); job.resolve(); }
    this.revision++; const operation = this.operation; this.operation = undefined; operation?.abort();
    this.player?.reset(); this.resetAudio(); this.publish({ state: "idle", messageId: null, progress: "" });
  }
  disable() {
    this.stop(); const player = this.player; this.player = undefined; void player?.stop().catch(() => {});
    this.publish({ enabled: false, permitted: false, preferredEnabled: false, error: null, notice: null }); this.save();
  }
  setVolume(value: number) {
    if (!Number.isFinite(value) || value < 0 || value > 1) return;
    this.player?.setVolume(value); this.publish({ volume: value }); this.save();
  }
  private mark(id: string) { this.handled.add(id); if (this.handled.size > 128) this.handled.delete(this.handled.values().next().value!); }
  private startJob(message: Message, progressive: boolean, automatic: boolean) {
    this.mark(message.id);
    let resolve!: () => void;
    const complete = new Promise<void>(done => { resolve = done; });
    const requestId = automatic && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(message.id) ? message.id : crypto.randomUUID();
    const job: SpeechJob = { id: message.id, progressive, buffer: new CloudSpeechBuffer(progressive), abort: new AbortController(), requestId, complete, resolve };
    this.job = job; this.operation = job.abort;
    this.publish({ state: "buffering", messageId: message.id, progress: "Waiting for a natural speech boundary…", error: null, notice: null });
    return job;
  }
  private feed(job: SpeechJob, content: string, final: boolean) {
    job.buffer.update(content, final);
    if (job.buffer.truncated) this.publish({ notice: "Cloud speech reads up to 800 spoken characters per response." });
    const wake = job.wake; job.wake = undefined; wake?.();
  }
  private async run(job: SpeechJob) {
    let player: Player | undefined, unlocked = false, spoke = false;
    const signal = job.abort.signal;
    const live = () => this.job === job && !this.disposed;
    const abort = () => { if (live()) { player?.reset(); this.resetAudio(); } job.wake?.(); job.wake = undefined; };
    signal.addEventListener("abort", abort, { once: true });
    job.timer = setTimeout(() => job.abort.abort(), 90_000);
    try {
      player = this.ensurePlayer(); await player.unlock(); unlocked = true; signal.throwIfAborted();
      if (job.progressive) player.beginSegment();
      while (live()) {
        signal.throwIfAborted();
        if (job.buffer.rewritten) throw new CloudVoiceRequestError("The response changed after speech began. Use Read to hear the completed response without automatic repeats.");
        const next = job.buffer.next();
        if (next) {
          spoke = true;
          if (this.view.state !== "playing") this.publish({ state: "generating", progress: "Generating cloud speech…" });
          await this.stream(next.text, APPROVED_VOICE_PRESET.voice, signal, pcm => {
            if (live() && !signal.aborted) player!.append(pcm);
          }, undefined, job.requestId, undefined, job.progressive ? { index: next.index, final: next.final } : undefined);
          signal.throwIfAborted();
          if (!live()) return;
          if (job.progressive) player.endSegment();
        } else if (job.buffer.finished) {
          if (!spoke) this.publish({ notice: "Nothing to read aloud. Code blocks and oversized words are skipped." });
          await player.finish(); signal.throwIfAborted(); return;
        } else {
          // Recheck is synchronous before registering the waiter; snapshots wake this one lane.
          await new Promise<void>(resolve => { job.wake = resolve; if (signal.aborted) resolve(); });
        }
      }
    } catch (failure) {
      if (live()) this.publish({ state: "error", ...(!unlocked ? { permitted: false } : {}), error: signal.aborted ? "Cloud speech timed out. Use Read to try again explicitly." : failure instanceof CloudVoiceRequestError ? failure.message : "Cloud speech could not complete. Check the session and voice configuration, then use Read to try again explicitly." });
    } finally {
      clearTimeout(job.timer); signal.removeEventListener("abort", abort);
      if (live()) {
        this.job = undefined; this.operation = undefined; player?.reset(); this.resetAudio();
        this.publish({ state: this.view.error ? "error" : "idle", messageId: null, progress: "" });
      }
      job.resolve();
    }
  }
  async play(message: Message, automatic = false) {
    if (this.disposed || this.operation || !this.view.enabled || !this.view.permitted || message.role !== "assistant" || message.status !== "complete") return;
    const job = this.startJob(message, false, automatic); this.feed(job, message.content, true); void this.run(job); await job.complete;
  }
  observe(messages: readonly Message[], requestId: string | null, assistantId: string | null, conversationId: string | null, loading: string | null) {
    if (loading || (this.conversation !== undefined && this.conversation !== conversationId && !requestId)) {
      this.stop(); this.conversation = conversationId; return;
    }
    this.conversation = conversationId;
    if (requestId) {
      if (requestId === this.suppressed) return;
      if (this.candidate?.request !== requestId && this.operation) this.stop();
      this.candidate = { request: requestId, assistant: assistantId };
      const message = messages.find(item => item.id === assistantId && item.role === "assistant" && item.status === "streaming" && item.content);
      if (!message || !this.view.enabled || !this.view.permitted) return;
      if (this.job?.id === message.id && this.job.progressive) this.feed(this.job, message.content, false);
      else if (!this.operation && !this.handled.has(message.id)) {
        const job = this.startJob(message, true, true); this.feed(job, message.content, false); void this.run(job);
      }
      return;
    }
    const candidate = this.candidate; this.candidate = null;
    if (!candidate) return;
    const message = messages.find(item => item.id === candidate.assistant && item.role === "assistant" && item.status === "complete");
    if (message && this.job?.id === message.id && this.job.progressive) this.feed(this.job, message.content, true);
    else if (message && !this.handled.has(message.id)) void this.play(message, true);
    else if (!message && this.job?.id === candidate.assistant && this.job.progressive) this.stop();
  }
  dispose() { this.disable(); this.disposed = true; this.listeners.clear(); }
}
