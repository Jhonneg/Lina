import { voiceTrace } from "./diagnostics";
import { createRefinedGraph, createRefinedImpulse, refinedPlaybackDuration } from "./refined";
import { VoiceError, validateSpeechText, type GenerationOptions, type SpeechProvider, type VoiceState } from "./types";

type Operation = { controller: AbortController; signal: AbortSignal };
export type VoiceEngineOptions = { provider: SpeechProvider; contextFactory?: () => AudioContext; onStateChange?: (state: VoiceState) => void };

export class VoiceEngine {
  private context?: AudioContext;
  private impulse?: AudioBuffer;
  private graph?: ReturnType<typeof createRefinedGraph>;
  private source?: AudioBufferSourceNode;
  private operation?: Operation;
  private preparation?: Operation;
  private queued = new Set<AudioBufferSourceNode>();
  private queuedUntil = 0;
  private queueSignal?: AbortSignal;
  private volume = 1;
  private currentState: VoiceState = "idle";
  private disposed = false;
  private readonly hide = () => this.stop();
  constructor(private readonly options: VoiceEngineOptions) {
    if (typeof window !== "undefined") window.addEventListener("pagehide", this.hide);
  }
  get state() { return this.currentState; }
  /** Valid only during playback; reacquire after each play. No analysis polling loop is started. */
  get analyser() { return this.graph?.an ?? null; }
  getVolume() { return this.volume; }
  setVolume(value: number) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new VoiceError("input", "Volume must be between 0 and 1.");
    this.volume = value;
    if (this.graph && this.context) this.graph.output.gain.setTargetAtTime(value, this.context.currentTime, .035);
  }
  private setState(state: VoiceState) {
    this.currentState = state;
    try { this.options.onStateChange?.(state); } catch { /* Observers do not own audio resources. */ }
  }
  private audioContext() {
    if (this.disposed) throw new VoiceError("disposed", "The voice engine has been disposed.");
    if (!this.context) {
      if (this.options.contextFactory) this.context = this.options.contextFactory();
      else {
        const Audio = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Audio) throw new VoiceError("unsupported", "This browser does not support Web Audio.");
        this.context = new Audio();
      }
    }
    return this.context;
  }
  private start(signal?: AbortSignal, preservePreparation = false): Operation {
    if (this.disposed) throw new VoiceError("disposed", "The voice engine has been disposed.");
    if (preservePreparation) this.stopPlayback(); else this.stop();
    const controller = new AbortController(), combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const operation = { controller, signal: combined }; this.operation = operation;
    return operation;
  }
  private check(operation: Operation) {
    operation.signal.throwIfAborted();
    if (this.operation !== operation || this.disposed) throw new DOMException("Speech cancelled.", "AbortError");
  }
  private async run<T>(signal: AbortSignal | undefined, work: (operation: Operation) => Promise<T>, preservePreparation = false) {
    const operation = this.start(signal, preservePreparation);
    const abort = () => { if (this.operation === operation) this.stop(); };
    operation.signal.addEventListener("abort", abort, { once: true });
    try { this.check(operation); return await work(operation); }
    catch (error) {
      const cancelled = operation.signal.aborted || this.operation !== operation;
      if (this.operation === operation) {
        this.stop(); if (!cancelled) this.setState("error");
      }
      if (cancelled) throw new DOMException("Speech cancelled.", "AbortError");
      if (error instanceof VoiceError) throw error;
      throw new VoiceError("playback", "Unable to decode or play speech audio.");
    } finally { operation.signal.removeEventListener("abort", abort); }
  }
  private async decode(text: string, operation: Operation, onProgress: GenerationOptions["onProgress"]) {
    validateSpeechText(text); this.setState("loading");
    const encoded = await this.options.provider.generate(text, { signal: operation.signal, onProgress: progress => {
      if (this.operation !== operation || operation.signal.aborted) return;
      this.setState(progress.phase);
      try { onProgress?.(progress); } catch { /* Ignore observer errors. */ }
    } });
    this.check(operation);
    const audio = await this.audioContext().decodeAudioData(encoded);
    this.check(operation); return audio;
  }
  private async resume(operation: Operation) {
    const ctx = this.audioContext();
    if (ctx.state !== "running") {
      // Called before any model await in speak(), so a click can unlock playback.
      const resumed = ctx.resume();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => { rejectAbort?.(new DOMException("Playback cancelled.", "AbortError")); };
      let rejectAbort: ((reason: Error) => void) | undefined;
      try {
        await Promise.race([resumed, new Promise<never>((_, reject) => {
          rejectAbort = reject;
          timer = setTimeout(() => reject(new VoiceError("autoplay", "Playback is blocked. Call unlock() or speak() from a user gesture.")), 3000);
          operation.signal.addEventListener("abort", abort, { once: true });
          if (operation.signal.aborted) abort();
        })]);
      } catch (error) {
        if (operation.signal.aborted || error instanceof VoiceError) throw error;
        throw new VoiceError("autoplay", "Playback is blocked. Enable audio from a user gesture.");
      } finally { clearTimeout(timer); operation.signal.removeEventListener("abort", abort); }
    }
    this.check(operation);
    if (ctx.state !== "running") throw new VoiceError("autoplay", "Audio is suspended. Enable audio from a user gesture.");
  }
  /** Call synchronously from a click/tap before generating audio for later playback. */
  unlock() {
    return this.run(undefined, async operation => { await this.resume(operation); this.operation = undefined; });
  }
  generate(text: string, { signal, onProgress }: GenerationOptions = {}) {
    return this.run(signal, async operation => {
      const audio = await this.decode(text, operation, onProgress);
      this.operation = undefined; this.setState("idle"); return audio;
    });
  }
  private startPlayback(audio: AudioBuffer, operation: Operation) {
    this.check(operation);
    const ctx = this.audioContext();
    if (ctx.state !== "running") throw new VoiceError("autoplay", "Audio was suspended. Enable audio again from a user gesture.");
    this.impulse ??= createRefinedImpulse(ctx);
    this.graph = createRefinedGraph(ctx, this.impulse, this.volume);
    this.source = ctx.createBufferSource(); this.source.buffer = audio; this.source.connect(this.graph.hp); this.graph.apply(this.source);
    this.source.onended = () => { if (this.operation === operation) this.stopPlayback(); };
    this.source.start(); this.setState("playing");
    // run() removes its setup listener when playback starts. Keep cancellation live until ended.
    const abort = () => { if (this.operation === operation) this.stop(); };
    operation.signal.addEventListener("abort", abort, { once: true });
    this.playbackCleanup = () => operation.signal.removeEventListener("abort", abort);
  }
  private playbackCleanup?: () => void;
  /** Resolves when playback starts; state/onStateChange reports completion. */
  play(audio: AudioBuffer, signal?: AbortSignal) {
    return this.run(signal, async operation => { await this.resume(operation); this.startPlayback(audio, operation); }, true);
  }
  /** At most two sources: current audio plus one buffer scheduled ahead. Shares the Refined graph. */
  async enqueue(audio: AudioBuffer, signal: AbortSignal, ended: () => void) {
    signal.throwIfAborted();
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) throw new VoiceError("input", "Speech audio is empty.");
    if (this.queued.size >= 2) throw new VoiceError("busy", "The speech playback queue is full.");
    if (this.queued.size) {
      if (this.queueSignal !== signal || !this.operation) throw new VoiceError("busy", "Another speech operation is playing.");
      try { this.schedule(audio, this.operation, ended); }
      catch (error) { this.stop(); throw error; }
      return;
    }
    return this.run(signal, async operation => {
      await this.resume(operation);
      const ctx = this.audioContext();
      this.impulse ??= createRefinedImpulse(ctx);
      this.graph = createRefinedGraph(ctx, this.impulse, this.volume);
      this.queuedUntil = ctx.currentTime; this.queueSignal = signal;
      this.schedule(audio, operation, ended);
      const abort = () => { if (this.operation === operation) this.stop(); };
      operation.signal.addEventListener("abort", abort, { once: true });
      this.playbackCleanup = () => operation.signal.removeEventListener("abort", abort);
      this.setState("playing");
    }, true);
  }
  private schedule(audio: AudioBuffer, operation: Operation, ended: () => void) {
    this.check(operation);
    const ctx = this.audioContext(), graph = this.graph!;
    const at = Math.max(ctx.currentTime, this.queuedUntil), source = ctx.createBufferSource();
    this.queued.add(source);
    source.buffer = audio; source.connect(graph.hp); graph.apply(source, at);
    source.onended = () => {
      if (this.operation !== operation) return;
      this.queued.delete(source); source.disconnect();
      if (!this.queued.size) this.stopPlayback();
      voiceTrace("playback-ended"); ended();
    };
    source.start(at);
    this.queuedUntil = at + refinedPlaybackDuration(audio.duration);
    voiceTrace("playback-scheduled", { delayMs: (at - ctx.currentTime) * 1000, durationMs: (this.queuedUntil - at) * 1000, depth: this.queued.size });
  }
  speak(text: string, { signal, onProgress }: GenerationOptions = {}) {
    return this.run(signal, async operation => {
      validateSpeechText(text); await this.resume(operation);
      const audio = await this.decode(text, operation, onProgress); this.startPlayback(audio, operation);
    });
  }
  /** One independent synthesis slot; never interrupts playback or creates another model. */
  async prepare(text: string, { signal, onProgress }: GenerationOptions = {}) {
    if (this.disposed) throw new VoiceError("disposed", "The voice engine has been disposed.");
    if (this.preparation) throw new VoiceError("busy", "Speech preparation is already in progress.");
    validateSpeechText(text);
    const controller = new AbortController(), operation = { controller, signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal };
    this.preparation = operation;
    try {
      operation.signal.throwIfAborted();
      const started = performance.now();
      const encoded = await this.options.provider.generate(text, { signal: operation.signal, onProgress });
      operation.signal.throwIfAborted();
      const audio = await this.audioContext().decodeAudioData(encoded);
      operation.signal.throwIfAborted();
      voiceTrace("prepared", { elapsedMs: performance.now() - started, audioSeconds: audio.duration });
      if (this.preparation !== operation || this.disposed) throw new DOMException("Speech cancelled.", "AbortError");
      return audio;
    } catch (error) {
      if (operation.signal.aborted) throw new DOMException("Speech cancelled.", "AbortError");
      if (error instanceof VoiceError) throw error;
      throw new VoiceError("generation", "Unable to prepare speech audio.");
    } finally { if (this.preparation === operation) this.preparation = undefined; }
  }
  private stopPlayback() {
    const operation = this.operation; this.operation = undefined;
    this.playbackCleanup?.(); this.playbackCleanup = undefined;
    operation?.controller.abort();
    if (this.source) { this.source.onended = null; try { this.source.stop(); } catch { /* Already ended. */ } this.source.disconnect(); this.source = undefined; }
    for (const source of this.queued) { source.onended = null; try { source.stop(); } catch { /* Already ended. */ } source.disconnect(); }
    this.queued.clear(); this.queuedUntil = 0; this.queueSignal = undefined;
    this.graph?.disconnect(); this.graph = undefined;
    if (!this.disposed) this.setState("idle");
  }
  stop() {
    const preparation = this.preparation; this.preparation = undefined; preparation?.controller.abort();
    this.stopPlayback();
  }
  async dispose() {
    if (this.disposed) return;
    this.stop(); this.disposed = true;
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this.hide);
    this.options.provider.dispose(); this.impulse = undefined;
    const ctx = this.context; this.context = undefined;
    try { if (ctx && ctx.state !== "closed") await ctx.close(); }
    finally { this.setState("disposed"); }
  }
}
