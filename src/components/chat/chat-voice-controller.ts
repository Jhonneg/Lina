import { voiceTrace } from "../../lib/voice/diagnostics";
import type { VoiceEngine, VoiceEngineOptions } from "../../lib/voice/engine";
import type { VoiceState } from "../../lib/voice/types";
import { AudioReactivity } from "../../lib/audio/reactivity";
import type { Message } from "./chat-types";
import { SpeechSegmenter } from "./speech-segmenter";

export type VoiceView = {
  enabled: boolean; permitted: boolean; consented: boolean; preferredEnabled: boolean; volume: number;
  state: VoiceState | "activating" | "buffering"; messageId: string | null; progress: string; error: string | null; notice: string | null;
};
export const INITIAL_VOICE: VoiceView = { enabled: false, permitted: false, consented: false, preferredEnabled: false, volume: 1,
  state: "idle", messageId: null, progress: "", error: null, notice: null };
export type ChatVoiceEngine = Pick<VoiceEngine, "state" | "analyser" | "unlock" | "speak" | "prepare" | "play" | "stop" | "setVolume" | "dispose"> & Partial<Pick<VoiceEngine, "enqueue">>;
export type VoiceFactory = (options: Pick<VoiceEngineOptions, "onStateChange">) => ChatVoiceEngine;

export const SPEECH_QUEUE_LIMIT = 8;
type SpeechJob = {
  id: string; manual: boolean; abort: AbortController; segmenter: SpeechSegmenter; queue: string[];
  preparing: boolean; playing: boolean; ready?: AudioBuffer; phase: "loading" | "generating";
  scheduled: number; eligible: number; played: number; completed: number; started: number; waiting?: number;
  complete: Promise<void>; resolve: () => void;
};
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const PREFERENCE_KEY = "lain.voice-preferences.v1";

export class ChatVoiceController {
  view: VoiceView = INITIAL_VOICE;
  private engine?: ChatVoiceEngine;
  private revision = 0;
  private operation?: AbortController;
  private ended?: () => void;
  private candidate: { request: string; assistant: string | null } | null = null;
  private suppressed: string | null = null;
  private conversation: string | null | undefined;
  private listeners = new Set<() => void>();
  private disposed = false;
  private job?: SpeechJob;
  private seen = new Set<string>();
  constructor(private readonly factory: VoiceFactory, readonly audio: { current: AudioReactivity | null }, private readonly storage?: Storage) {
    try {
      const saved = JSON.parse(storage?.getItem(PREFERENCE_KEY) ?? "null");
      if (saved?.version === 1) this.view = { ...INITIAL_VOICE, consented: saved.consented === true, preferredEnabled: saved.enabled === true,
        volume: typeof saved.volume === "number" && Number.isFinite(saved.volume) && saved.volume >= 0 && saved.volume <= 1 ? saved.volume : 1 };
    } catch { /* Storage is optional; it never grants playback permission. */ }
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private publish(patch: Partial<VoiceView>) {
    if (this.disposed || Object.entries(patch).every(([key, value]) => this.view[key as keyof VoiceView] === value)) return;
    this.view = { ...this.view, ...patch }; for (const listener of this.listeners) listener();
  }
  private save() {
    try { this.storage?.setItem(PREFERENCE_KEY, JSON.stringify({ version: 1, consented: this.view.consented, enabled: this.view.preferredEnabled, volume: this.view.volume })); } catch { /* No persistence is required for playback. */ }
  }
  private resetAudio() { this.audio.current?.dispose(); this.audio.current = null; }
  private ensureEngine() {
    if (!this.engine) {
      const engine = this.factory({ onStateChange: state => {
        if (this.engine !== engine || this.disposed) return;
        this.resetAudio();
        if (!this.operation) return;
        if (state === "playing" && engine.analyser) this.audio.current = new AudioReactivity(engine.analyser);
        if (state === "playing") this.publish({ state, progress: "" });
        if (state === "idle") this.ended?.();
      } });
      this.engine = engine; engine.setVolume(this.view.volume);
    }
    return this.engine;
  }
  /** Invoke from a click/tap. Restored preferences alone never call this. */
  async enable(consent = false): Promise<boolean> {
    if (this.disposed || (!this.view.consented && !consent)) return false;
    this.stop(false); const revision = this.revision;
    if (consent) { this.publish({ consented: true }); this.save(); }
    this.publish({ state: "activating", error: null });
    try {
      const engine = this.ensureEngine();
      // No await before unlock: preserve transient user activation.
      await engine.unlock();
      if (revision !== this.revision || this.disposed || this.engine !== engine) return false;
      this.publish({ enabled: true, permitted: true, preferredEnabled: true, state: "idle" }); this.save(); return true;
    } catch (error) {
      if (revision === this.revision && !this.disposed) {
        const failed = this.engine; this.engine = undefined; failed?.stop(); void failed?.dispose().catch(() => {});
        this.publish({ enabled: false, state: "error", permitted: false, error: error instanceof Error ? error.message : "Voice is unavailable. Text chat is still available." });
      }
      return false;
    }
  }
  stop(suppressAutomatic = true) {
    if (suppressAutomatic) { this.suppressed = this.candidate?.request ?? this.suppressed; this.candidate = null; }
    this.revision++;
    const job = this.job; this.job = undefined; if (job) { voiceTrace("job-cancelled", { eligible: job.eligible, played: job.played, completed: job.completed }); job.queue.length = 0; job.ready = undefined; job.resolve(); }
    const operation = this.operation; this.operation = undefined; operation?.abort();
    this.ended?.(); this.ended = undefined;
    this.engine?.stop(); this.resetAudio();
    this.publish({ state: "idle", messageId: null, progress: "" });
  }
  disable() {
    this.stop(); const engine = this.engine; this.engine = undefined;
    this.publish({ enabled: false, permitted: false, preferredEnabled: false, error: null, notice: null }); this.save();
    void engine?.dispose().catch(() => {});
  }
  setVolume(value: number) {
    if (!Number.isFinite(value) || value < 0 || value > 1) return;
    this.engine?.setVolume(value); this.publish({ volume: value }); this.save();
  }
  private mark(id: string) {
    this.seen.add(id);
    if (this.seen.size > 96) { const oldest = this.seen.values().next().value; if (oldest) this.seen.delete(oldest); }
  }
  private createJob(id: string, manual: boolean) {
    this.stop(false); this.mark(id);
    let resolve!: () => void;
    const complete = new Promise<void>(done => { resolve = done; });
    const job: SpeechJob = { id, manual, abort: new AbortController(), segmenter: new SpeechSegmenter(), queue: [], preparing: false,
      playing: false, phase: "loading", scheduled: 0, eligible: 0, played: 0, completed: 0, started: performance.now(), complete, resolve };
    this.job = job; this.operation = job.abort; voiceTrace("job-started", { manual });
    this.publish({ state: "buffering", messageId: id, error: null, notice: null, progress: "Waiting for a sentence…" });
    return job;
  }
  private live(job: SpeechJob) { return this.job === job && !job.abort.signal.aborted && !this.disposed; }
  private fill(job: SpeechJob) {
    while (job.queue.length < SPEECH_QUEUE_LIMIT) {
      const segment = job.segmenter.next(); if (!segment) break; job.queue.push(segment);
      voiceTrace("segment-eligible", { index: ++job.eligible, characters: segment.length, elapsedMs: performance.now() - job.started, depth: job.queue.length });
    }
    if (job.segmenter.truncated) this.publish({ notice: job.segmenter.rewritten ? "The response changed after speech began. Reading stopped to avoid repeating text; use Read to hear the saved response." : "Reading up to 4,000 spoken characters. Oversized fragments may be omitted." });
  }
  private fail(job: SpeechJob, error: unknown) {
    if (!this.live(job)) return;
    this.stop(false);
    const blocked = error instanceof Error && "code" in error && error.code === "autoplay";
    this.publish({ state: "error", ...(blocked ? { permitted: false } : {}),
      error: error instanceof Error ? error.message : "Speech failed. Text chat is still available." });
  }
  private pump(job: SpeechJob) {
    if (!this.live(job)) return;
    try { this.fill(job); } catch (error) { this.fail(job, error); return; }
    const engine = this.ensureEngine();
    if (engine.enqueue && job.ready && job.scheduled < 2) {
      const audio = job.ready; job.ready = undefined; job.scheduled++; job.playing = true;
      voiceTrace("segment-scheduled", { index: ++job.played, elapsedMs: performance.now() - job.started, waitMs: job.waiting === undefined ? 0 : performance.now() - job.waiting });
      job.waiting = undefined;
      void engine.enqueue(audio, job.abort.signal, () => {
        if (!this.live(job)) return;
        job.scheduled--; job.completed++; job.playing = job.scheduled > 0;
        if (!job.playing && !job.ready && (job.preparing || job.queue.length || !job.segmenter.finished)) {
          job.waiting = performance.now(); voiceTrace("queue-underrun", { completed: job.completed, waitingForInference: job.preparing });
        }
        this.pump(job);
      }).catch(error => this.fail(job, error));
    } else if (!engine.enqueue && !job.playing && job.ready) {
      const audio = job.ready; job.ready = undefined; job.playing = true;
      this.ended = undefined;
      void engine.play(audio, job.abort.signal).then(() => {
        if (!this.live(job)) return;
        const ended = () => { if (!this.live(job)) return; this.ended = undefined; job.playing = false; this.resetAudio(); this.pump(job); };
        if (engine.state === "playing") this.ended = ended; else ended();
      }).catch(error => this.fail(job, error));
    }
    if (!job.preparing && !job.ready && job.queue.length) {
      const segment = job.queue.shift()!; voiceTrace("preparation-started", { characters: segment.length, queuedAudio: job.scheduled }); job.preparing = true; job.phase = "loading";
      void engine.prepare(segment, { signal: job.abort.signal, onProgress: value => {
        if (!this.live(job)) return;
        job.phase = value.phase;
        if (engine.state !== "playing") this.publish({ state: value.phase, progress: value.phase === "generating" ? "Generating Nicole speech…" :
          `Loading ${value.file ?? "Kokoro"}${value.percent === undefined ? "…" : ` · ${Math.floor(value.percent)}%`}` });
      } }).then(audio => {
        if (!this.live(job)) return;
        job.preparing = false; job.ready = audio; this.pump(job);
      }).catch(error => this.fail(job, error));
    }
    if (!job.playing && !job.preparing && !job.ready && !job.queue.length && job.segmenter.finished) {
      voiceTrace("job-completed", { eligible: job.eligible, played: job.played, completed: job.completed, truncated: job.segmenter.truncated });
      this.job = undefined; this.operation = undefined; this.ended = undefined; this.resetAudio(); job.resolve();
      this.publish({ state: "idle", messageId: null, progress: "" });
    } else if (engine.state !== "playing") {
      this.publish({ state: job.preparing ? job.phase : job.ready ? "generating" : "buffering", progress: job.preparing ? this.view.progress : "Waiting for a sentence…" });
    }
  }
  private feed(job: SpeechJob, content: string, final: boolean) {
    if (!this.live(job)) return;
    job.segmenter.update(content, final); this.pump(job);
  }
  async play(message: Message) {
    if (this.disposed || !this.view.enabled || !this.view.permitted || message.role !== "assistant" || message.status !== "complete") return;
    const job = this.createJob(message.id, true);
    this.feed(job, message.content, true);
    if (job.segmenter.finished && !job.queue.length && !job.preparing && !job.playing) this.publish({ notice: "Nothing to read aloud. Code blocks are skipped." });
    await job.complete;
  }
  /** Streaming snapshots are append-buffered; completion finalizes, never replays. */
  observe(messages: readonly Message[], requestId: string | null, assistantId: string | null, conversationId: string | null, loading: string | null) {
    if (loading || (this.conversation !== undefined && this.conversation !== conversationId && !requestId && !this.candidate)) {
      this.stop(); this.conversation = conversationId; return;
    }
    this.conversation = conversationId;
    if (requestId) {
      if (requestId === this.suppressed) return;
      this.candidate = { request: requestId, assistant: assistantId };
      const message = messages.find(item => item.id === assistantId && item.role === "assistant" && item.status === "streaming");
      if (!message || !this.view.enabled || !this.view.permitted) return;
      if (this.job?.manual) return; // Explicit manual playback takes priority.
      if (this.job?.id === message.id) this.feed(this.job, message.content, false);
      else if (!this.seen.has(message.id)) this.feed(this.createJob(message.id, false), message.content, false);
      return;
    }
    const candidate = this.candidate; this.candidate = null;
    if (!candidate) return;
    const message = messages.find(item => item.id === candidate.assistant && item.role === "assistant");
    if (message?.status === "complete") {
      if (this.job?.id === message.id && !this.job.manual) this.feed(this.job, message.content, true);
      else if (!this.seen.has(message.id) && this.view.enabled && this.view.permitted && !this.job?.manual) this.feed(this.createJob(message.id, false), message.content, true);
      this.mark(message.id);
    } else if (this.job?.id === candidate.assistant && !this.job.manual) this.stop(false);
  }
  dispose() {
    this.stop(); const engine = this.engine; this.engine = undefined; this.disposed = true; this.listeners.clear();
    void engine?.dispose().catch(() => {});
  }
}
