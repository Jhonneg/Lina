import { createDesignGraph, designDuration } from "./design-dsp";
import type { DesignEffects } from "./design-presets";

/** PCM16 mono/24 kHz source, independent of Kokoro and all model-loading modules. */
export class DesignVoicePlayer {
  private context: AudioContext;
  private graph?: ReturnType<typeof createDesignGraph>;
  private analysis?: AnalyserNode;
  private sources = new Set<AudioBufferSourceNode>();
  private until = 0;
  private segmented = false;
  private segmentStart = false;
  private lastBlock?: { gain: GainNode; end: number };
  private gains = new Map<AudioBufferSourceNode, GainNode>();
  private received = 0;
  private first = true;
  private pending = new Float32Array(2400);
  private pendingLength = 0;
  private stopped = false;
  private complete = false;
  private resolve?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private volume = 1;
  private isPlaying = false;
  private setPlaying(value: boolean) { if (this.isPlaying !== value) { this.isPlaying = value; this.playing(value); } }
  constructor(private readonly settings: DesignEffects, private readonly playing: (value: boolean) => void, contextFactory = () => new AudioContext()) { this.context = contextFactory(); }
  get analyser() { return this.analysis ?? null; }
  async unlock() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.context.resume(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Playback is blocked. Enable voice again.")), 3000); })]); }
    finally { clearTimeout(timer); }
    if (this.context.state !== "running") throw Error("Playback is blocked. Press Speak again to allow audio.");
  }
  setVolume(value: number) {
    this.volume = Math.min(1, Math.max(0, value));
    this.graph?.setVolume(this.volume);
  }

  append(pcm: string) {
    if (this.stopped || this.complete) return;
    const raw = atob(pcm); this.received += raw.length;
    if (!raw.length || raw.length % 2 || this.received > 24_000 * 2 * 60 || this.sources.size >= 1000) throw Error("Audio exceeded the evaluation limit.");
    if (!this.analysis) {
      this.graph = createDesignGraph(this.context, this.settings, this.volume); this.analysis = this.graph.analyser;
    }

    for (let i = 0; i < raw.length; i += 2) {
      const value = raw.charCodeAt(i) | (raw.charCodeAt(i + 1) << 8);
      this.pending[this.pendingLength++] = (value >= 32768 ? value - 65536 : value) / 32768;
      if (this.pendingLength === this.pending.length) this.schedule();
    }
  }
  private schedule() {
    const audio = this.context.createBuffer(1, this.pendingLength, 24000);
    audio.getChannelData(0).set(this.pending.subarray(0, this.pendingLength)); this.pendingLength = 0;
    const source = this.context.createBufferSource(); source.buffer = audio;
    let block: GainNode | undefined;
    if (this.segmented) { block = this.context.createGain(); source.connect(block); block.connect(this.graph!.input); this.gains.set(source, block); }
    else source.connect(this.graph!.input);
    const now = this.context.currentTime, at = Math.max(now + (this.sources.size ? 0 : .08), this.until);
    const rate = this.graph!.rate;
    this.graph!.apply(source, at, this.first);
    const duration = designDuration(audio.duration, rate, this.first);
    this.first = false; this.until = at + duration;
    if (block) {
      if (this.segmentStart) { block.gain.setValueAtTime(0, at); block.gain.linearRampToValueAtTime(1, at + Math.min(.004, duration / 2)); }
      this.segmentStart = false; this.lastBlock = { gain: block, end: this.until };
    }
    const starting = this.sources.size === 0;
    this.sources.add(source);
    source.onended = () => {
      if (this.stopped) return;
      this.sources.delete(source); source.disconnect(); this.gains.get(source)?.disconnect(); this.gains.delete(source);
      if (!this.sources.size) { this.setPlaying(false); if (this.complete) this.resolve?.(); }
    };
    if (starting) {
      this.graph!.envelope.gain.cancelScheduledValues(at);
      this.graph!.envelope.gain.setValueAtTime(0, at);
      this.graph!.envelope.gain.linearRampToValueAtTime(1, at + .01);
    }
    source.start(at);
    if (starting) this.timer = setTimeout(() => { if (!this.stopped && this.sources.size) this.setPlaying(true); }, Math.max(0, (at - now) * 1000));
  }
  /** One graph/clock for the utterance; tiny source envelopes smooth independent PCM seams. */
  beginSegment() { this.segmented = true; this.segmentStart = true; }
  endSegment() {
    if (this.stopped || this.complete) return;
    if (this.pendingLength) this.schedule();
    const last = this.lastBlock, now = this.context.currentTime;
    if (last && last.end > now + .005) {
      last.gain.gain.setValueAtTime(1, last.end - .004); last.gain.gain.linearRampToValueAtTime(0, last.end);
    }
    this.lastBlock = undefined; this.segmentStart = true;
  }
  finish() {
    if (!this.stopped && this.pendingLength) this.schedule();
    if (this.graph && this.until > this.context.currentTime + .02) {
      this.graph.envelope.gain.setValueAtTime(1, this.until - .015);
      this.graph.envelope.gain.linearRampToValueAtTime(0, this.until);
    }
    this.complete = true;
    if (!this.sources.size) return Promise.resolve();
    return new Promise<void>(resolve => { this.resolve = resolve; });
  }
  /** Clear an utterance while preserving the explicitly activated audio context. */
  reset() {
    clearTimeout(this.timer);
    for (const source of this.sources) { source.onended = null; try { source.stop(); } catch { /* Already ended. */ } source.disconnect(); }
    this.sources.clear(); for (const gain of this.gains.values()) gain.disconnect(); this.gains.clear();
    this.segmented = false; this.segmentStart = false; this.lastBlock = undefined;
    this.pendingLength = 0; this.setPlaying(false); this.resolve?.(); this.resolve = undefined;
    this.graph?.dispose();
    this.graph = undefined; this.analysis = undefined;
    this.received = 0; this.first = true; this.until = 0; this.complete = false;
  }
  async stop() {
    if (this.stopped) return; this.stopped = true; clearTimeout(this.timer);
    if (this.graph) {
      const gain = this.graph.envelope.gain, now = this.context.currentTime;
      gain.cancelScheduledValues(now); gain.setTargetAtTime(0, now, .008);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    this.reset();
    await this.context.close();
  }
}
