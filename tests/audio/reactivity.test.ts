import assert from "node:assert/strict";
import { test } from "node:test";
import { AudioReactivity, DEFAULT_REACTIVITY, smoothSignal, unit } from "../../src/lib/audio/reactivity";
import { applyOrbAudio, type OrbAudioUniforms } from "../../src/components/orb/orb-audio";

class Analyser {
  fftSize = 2048; frequencyBinCount = 1024;
  context = { state: "running", sampleRate: 48000 };
  amplitude = .1; low = 255; mid = 128; high = 64; reads = 0;
  getFloatTimeDomainData(target: Float32Array) { this.reads++; target.fill(this.amplitude); }
  getByteFrequencyData(target: Uint8Array) {
    target.fill(0);
    for (let i = 0; i < target.length; i++) {
      const hz = i * this.context.sampleRate / this.fftSize;
      if (hz >= 70 && hz < 250) target[i] = this.low;
      else if (hz >= 250 && hz < 2000) target[i] = this.mid;
      else if (hz >= 2000 && hz < 8000) target[i] = this.high;
    }
  }
  asAudio() { return this as unknown as AnalyserNode; }
}
function uniforms(): OrbAudioUniforms { return { audioRms: { value: 0 }, audioBass: { value: 0 }, audioMid: { value: 0 }, audioHigh: { value: 0 }, pulse: { value: 0 } }; }

test("normalization uses reference RMS gain and frequency ranges, saturates and never emits NaN", () => {
  assert.equal(unit(NaN), 0); assert.equal(unit(Infinity), 0); assert.equal(unit(-1), 0); assert.equal(unit(2), 1);
  const analyser = new Analyser(), reader = new AudioReactivity(analyser.asAudio(), { sensitivity: 1 });
  const signal = reader.sample(10);
  assert.ok(Math.abs(signal.rms - .5) < .000001);
  assert.equal(signal.bass, 1); assert.ok(Math.abs(signal.mid - 128 / 255) < .000001); assert.ok(Math.abs(signal.treble - 64 / 255) < .000001);
  analyser.amplitude = 10; reader.configure({ sensitivity: 2.5 }); reader.sample(10);
  assert.equal(signal.rms, 1); assert.equal(signal.mid, 1); assert.equal(signal.treble, 64 / 255 * 2.5);
  analyser.amplitude = NaN; reader.sample(10); assert.equal(signal.rms, 0);
});

test("attack and release match the V3 at 60Hz and are frame-rate independent", () => {
  const { attackSeconds: a, releaseSeconds: r } = DEFAULT_REACTIVITY;
  assert.ok(Math.abs(smoothSignal(0, 1, 1 / 60, a, r) - .35) < 1e-12);
  assert.ok(Math.abs(smoothSignal(1, 0, 1 / 60, a, r) - .88) < 1e-12);
  let fast = 0, slow = 0;
  for (let i = 0; i < 60; i++) fast = smoothSignal(fast, .8, 1 / 60, a, r);
  for (let i = 0; i < 30; i++) slow = smoothSignal(slow, .8, 1 / 30, a, r);
  assert.ok(Math.abs(fast - slow) < 1e-5);
  assert.equal(smoothSignal(.5, 1, -1, a, r), .5);
  assert.equal(smoothSignal(.5, 1, NaN, a, r), .5);
});

test("silence/noise gate, suspended contexts, and changed FFT decay smoothly to zero", () => {
  const analyser = new Analyser(), reader = new AudioReactivity(analyser.asAudio());
  const signal = reader.sample(1); const previous = signal.rms;
  analyser.amplitude = .001; reader.sample(1 / 60);
  assert.ok(signal.rms > 0 && signal.rms < previous);
  for (let i = 0; i < 180; i++) reader.sample(1 / 60);
  assert.deepEqual(signal, { rms: 0, bass: 0, mid: 0, treble: 0 });
  analyser.amplitude = .1; reader.sample(1); analyser.context.state = "suspended"; reader.sample(10);
  assert.equal(signal.rms, 0);
  analyser.context.state = "running"; reader.sample(1); analyser.fftSize = 1024; reader.sample(10);
  assert.equal(signal.bass, 0);
});

test("sampling reuses signal/buffers; sensitivity and cleanup leave analyser ownership with voice", () => {
  const analyser = new Analyser(), reader = new AudioReactivity(analyser.asAudio());
  const signal = reader.signal, wave = reader.wave, bins = reader.bins;
  for (let i = 0; i < 100; i++) assert.equal(reader.sample(1 / 60), signal);
  assert.equal(reader.wave, wave); assert.equal(reader.bins, bins);
  reader.configure({ sensitivity: 0 }); reader.sample(10); assert.equal(signal.rms, 0);
  for (const options of [{ sensitivity: NaN }, { sensitivity: 3 }, { attackSeconds: 0 }, { releaseSeconds: -1 }, { noiseFloor: 2 }]) assert.throws(() => reader.configure(options), RangeError);
  reader.dispose(); reader.dispose(); const reads = analyser.reads;
  reader.sample(1); assert.equal(analyser.reads, reads); assert.ok(wave.every(value => value === 0) && bins.every(value => value === 0));
  assert.deepEqual(signal, { rms: 0, bass: 0, mid: 0, treble: 0 });
});

test("uniforms preserve baseline without audio; reduced motion and Stop/disposal reset audio immediately", () => {
  const live = uniforms();
  assert.equal(applyOrbAudio(live, null, 1, false, .8), 1); assert.equal(live.pulse.value, .8);
  const analyser = new Analyser(), reader = new AudioReactivity(analyser.asAudio());
  const expansion = applyOrbAudio(live, reader, 1, false, .8);
  assert.ok(expansion > 1 && expansion <= 1.045); assert.ok(live.audioBass.value > 0); assert.ok(live.pulse.value < .8);
  const reads = analyser.reads;
  assert.equal(applyOrbAudio(live, reader, 1, true, 0), 1); assert.equal(analyser.reads, reads);
  assert.equal(live.audioRms.value + live.audioBass.value + live.audioMid.value + live.audioHigh.value, 0);
  applyOrbAudio(live, reader, 1, false, .8); reader.dispose();
  assert.equal(applyOrbAudio(live, reader, 1, false, .8), 1); assert.equal(live.pulse.value, .8);
  assert.equal(live.audioRms.value + live.audioBass.value + live.audioMid.value + live.audioHigh.value, 0);
});
