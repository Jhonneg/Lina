export type AudioSignal = { rms: number; bass: number; mid: number; treble: number };
export type ReactivityOptions = { sensitivity: number; rmsGain: number; noiseFloor: number; attackSeconds: number; releaseSeconds: number };
// Equivalent to the V3 reference's 0.35 attack / 0.12 release at 60fps.
export const DEFAULT_REACTIVITY: Readonly<ReactivityOptions> = Object.freeze({
  sensitivity: 1.35, rmsGain: 5, noiseFloor: .002,
  attackSeconds: -1 / (60 * Math.log(.65)), releaseSeconds: -1 / (60 * Math.log(.88)),
});
export function unit(value: number) { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
export function smoothSignal(current: number, target: number, delta: number, attack: number, release: number) {
  current = unit(current); target = unit(target);
  const dt = Number.isFinite(delta) ? Math.max(0, delta) : 0;
  const seconds = target > current ? attack : release;
  return Math.abs(target - current) < .00001 ? target : current + (target - current) * (1 - Math.exp(-dt / seconds));
}
function band(bins: Uint8Array, hz: number, low: number, high: number) {
  const start = Math.ceil(low / hz), end = Math.min(bins.length, Math.ceil(high / hz));
  let sum = 0;
  for (let i = start; i < end; i++) sum += bins[i];
  return end > start ? sum / ((end - start) * 255) : 0;
}
/** Allocates only on attachment. sample() mutates the same signal and buffers. */
export class AudioReactivity {
  readonly signal: AudioSignal = { rms: 0, bass: 0, mid: 0, treble: 0 };
  readonly wave: Float32Array<ArrayBuffer>;
  readonly bins: Uint8Array<ArrayBuffer>;
  private settings: ReactivityOptions;
  private disposed = false;
  constructor(private readonly analyser: AnalyserNode, options: Partial<ReactivityOptions> = {}) {
    this.settings = { ...DEFAULT_REACTIVITY }; this.configure(options);
    this.wave = new Float32Array(analyser.fftSize);
    this.bins = new Uint8Array(analyser.frequencyBinCount);
  }
  configure(options: Partial<ReactivityOptions>) {
    const next = { ...this.settings, ...options };
    if (!Number.isFinite(next.sensitivity) || next.sensitivity < 0 || next.sensitivity > 2.5 ||
        !Number.isFinite(next.rmsGain) || next.rmsGain <= 0 || !Number.isFinite(next.noiseFloor) || next.noiseFloor < 0 || next.noiseFloor > 1 ||
        !Number.isFinite(next.attackSeconds) || next.attackSeconds <= 0 || !Number.isFinite(next.releaseSeconds) || next.releaseSeconds <= 0) throw new RangeError("Invalid audio reactivity settings.");
    this.settings = next;
  }
  sample(delta: number): AudioSignal {
    if (this.disposed) return this.signal;
    let rms = 0, bass = 0, mid = 0, treble = 0;
    // Suspended contexts and a changed FFT size act as silence; no resizing in the loop.
    if (this.analyser.context.state === "running" && this.analyser.fftSize === this.wave.length) {
      this.analyser.getFloatTimeDomainData(this.wave); this.analyser.getByteFrequencyData(this.bins);
      let sum = 0;
      for (let i = 0; i < this.wave.length; i++) { const value = this.wave[i]; if (Number.isFinite(value)) sum += value * value; }
      const amplitude = Math.sqrt(sum / this.wave.length);
      if (amplitude > this.settings.noiseFloor) {
        const hz = this.analyser.context.sampleRate / this.analyser.fftSize;
        rms = unit(unit(amplitude * this.settings.rmsGain) * this.settings.sensitivity);
        bass = unit(band(this.bins, hz, 70, 250) * this.settings.sensitivity);
        mid = unit(band(this.bins, hz, 250, 2000) * this.settings.sensitivity);
        treble = unit(band(this.bins, hz, 2000, 8000) * this.settings.sensitivity);
      }
    }
    const s = this.signal, a = this.settings.attackSeconds, r = this.settings.releaseSeconds;
    s.rms = smoothSignal(s.rms, rms, delta, a, r); s.bass = smoothSignal(s.bass, bass, delta, a, r);
    s.mid = smoothSignal(s.mid, mid, delta, a, r); s.treble = smoothSignal(s.treble, treble, delta, a, r);
    return s;
  }
  /** Does not disconnect the analyser: its voice engine owns the audio graph. */
  dispose() {
    this.disposed = true;
    this.signal.rms = this.signal.bass = this.signal.mid = this.signal.treble = 0;
    this.wave.fill(0); this.bins.fill(0);
  }
}
