import { createRefinedGraph, createRefinedImpulse, REFINED_PRESET, refinedPlaybackDuration } from "../voice/refined";

/** PCM16 mono/24 kHz source, independent of Kokoro and all model-loading modules. */
export class CloudVoicePlayer {
  private context: AudioContext;
  private graph?: ReturnType<typeof createRefinedGraph>;
  private output?: GainNode;
  private analysis?: AnalyserNode;
  private sources = new Set<AudioBufferSourceNode>();
  private until = 0;
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
  constructor(private readonly refined: boolean, private readonly playing: (value: boolean) => void, contextFactory = () => new AudioContext()) { this.context = contextFactory(); }
  get analyser() { return this.analysis ?? null; }
  async unlock() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.context.resume(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Playback is blocked. Enable voice again.")), 3000); })]); }
    finally { clearTimeout(timer); }
    if (this.context.state !== "running") throw Error("Playback is blocked. Press Speak again to allow audio.");
  }
  setVolume(value: number) {
    this.volume = Math.min(1, Math.max(0, value));
    const gain = this.graph?.output ?? this.output;
    if (gain) gain.gain.setTargetAtTime(this.volume, this.context.currentTime, .035);
  }
  append(pcm: string) {
    if (this.stopped || this.complete) return;
    const raw = atob(pcm); this.received += raw.length;
    if (!raw.length || raw.length % 2 || this.received > 24_000 * 2 * 60 || this.sources.size >= 1000) throw Error("Audio exceeded the evaluation limit.");
    if (!this.analysis) {
      if (this.refined) {
        this.graph = createRefinedGraph(this.context, createRefinedImpulse(this.context), this.volume); this.analysis = this.graph.an;
      } else {
        this.output = this.context.createGain(); this.output.gain.value = this.volume;
        this.analysis = this.context.createAnalyser(); this.analysis.fftSize = 2048; this.analysis.smoothingTimeConstant = .65;
        this.output.connect(this.analysis); this.analysis.connect(this.context.destination);
      }
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
    const source = this.context.createBufferSource(); source.buffer = audio; source.connect(this.graph?.hp ?? this.output!);
    const now = this.context.currentTime, at = Math.max(now + (this.sources.size ? 0 : .08), this.until);
    const rate = this.refined ? Math.pow(2, REFINED_PRESET.pitch / 12) : 1;
    if (this.first && this.graph) this.graph.apply(source, at); else source.playbackRate.value = rate;
    const duration = this.first && this.refined ? refinedPlaybackDuration(audio.duration) : audio.duration / rate;
    this.first = false; this.until = at + duration;
    const starting = this.sources.size === 0;
    this.sources.add(source);
    source.onended = () => {
      if (this.stopped) return;
      this.sources.delete(source); source.disconnect();
      if (!this.sources.size) { this.setPlaying(false); if (this.complete) this.resolve?.(); }
    };
    source.start(at);
    if (starting) this.timer = setTimeout(() => { if (!this.stopped && this.sources.size) this.setPlaying(true); }, Math.max(0, (at - now) * 1000));
  }
  finish() {
    if (!this.stopped && this.pendingLength) this.schedule();
    this.complete = true;
    if (!this.sources.size) return Promise.resolve();
    return new Promise<void>(resolve => { this.resolve = resolve; });
  }
  /** Clear an utterance while preserving the explicitly activated audio context. */
  reset() {
    clearTimeout(this.timer);
    for (const source of this.sources) { source.onended = null; try { source.stop(); } catch { /* Already ended. */ } source.disconnect(); }
    this.sources.clear(); this.pendingLength = 0; this.setPlaying(false); this.resolve?.(); this.resolve = undefined;
    this.graph?.disconnect(); this.output?.disconnect(); this.analysis?.disconnect();
    this.graph = undefined; this.output = undefined; this.analysis = undefined;
    this.received = 0; this.first = true; this.until = 0; this.complete = false;
  }
  async stop() {
    if (this.stopped) return; this.stopped = true; this.reset();
    await this.context.close();
  }
}
