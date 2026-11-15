import { createRefinedGraph, createRefinedImpulse } from "../voice/refined";
import type { DesignEffects } from "./design-presets";

/** Voice-design graph, also reused for the approved main-chat preset. Approved Refined keeps the original DSP; custom adds bounded doubling/limiting. */
export function createDesignGraph(ctx: AudioContext, settings: DesignEffects, volume: number) {
  const envelope = ctx.createGain(); envelope.gain.value = 0;
  const original = settings.mode === "original";
  const refined = original ? undefined : createRefinedGraph(ctx, createRefinedImpulse(ctx), volume);
  const output = refined?.output ?? ctx.createGain(), analyser = refined?.an ?? ctx.createAnalyser();
  output.gain.value = volume; analyser.fftSize = 2048; analyser.smoothingTimeConstant = .65;
  if (refined) output.disconnect(); else analyser.connect(ctx.destination);
  output.connect(envelope); envelope.connect(analyser);
  const extra: AudioNode[] = [], oscillators: OscillatorNode[] = [];
  if (refined && settings.mode === "custom") {
    // No feedback: a short, gently modulated delayed copy, never a repeating echo.
    const delay = ctx.createDelay(.05), doubled = ctx.createGain(), filter = ctx.createBiquadFilter();
    delay.delayTime.value = .015; filter.type = "lowpass"; filter.frequency.value = 6500; doubled.gain.value = settings.doubling / 100;
    const lfo = ctx.createOscillator(), depth = ctx.createGain(); lfo.frequency.value = .27; depth.gain.value = .002;
    lfo.connect(depth); depth.connect(delay.delayTime); refined.sum.connect(delay); delay.connect(filter); filter.connect(doubled); doubled.connect(refined.comp); lfo.start();
    const limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = -3; limiter.knee.value = 3; limiter.ratio.value = 20; limiter.attack.value = .001; limiter.release.value = .08;
    const ceiling = ctx.createWaveShaper(), curve = new Float32Array(4097);
    for (let i = 0; i < curve.length; i++) { const x = i / (curve.length - 1) * 2 - 1, a = Math.abs(x); curve[i] = Math.sign(x) * (a <= .8 ? a : .8 + .12 * Math.tanh((a - .8) / .12)); }
    ceiling.curve = curve;
    analyser.disconnect(); envelope.disconnect(); envelope.connect(limiter); limiter.connect(ceiling); ceiling.connect(analyser); analyser.connect(ctx.destination);
    extra.push(delay, doubled, filter, lfo, depth, limiter, ceiling); oscillators.push(lfo);
  }
  const rate = Math.pow(2, (original ? 0 : settings.pitch) / 12);
  return { input: refined?.hp ?? output, analyser, envelope, rate,
    apply(source: AudioBufferSourceNode, at: number, first: boolean) {
      if (first && refined) {
        refined.apply(source, at);
        if (settings.mode === "custom") {
          const t = ctx.currentTime, double = settings.doubling / 100;
          for (const [parameter, value] of [[refined.low.gain, settings.bass], [refined.dry.gain, 1 - settings.metal / 100], [refined.wet.gain, settings.metal / 100], [refined.osc.frequency, settings.carrier], [refined.room.gain, settings.room / 100 * (1 - double)], [refined.direct.gain, (1 - settings.room / 100) * (1 - double)]] as const) {
            parameter.cancelScheduledValues(t); parameter.setTargetAtTime(value, t, .035);
          }
          source.playbackRate.cancelScheduledValues(at); source.playbackRate.setTargetAtTime(rate, at, .04);
        }
      } else source.playbackRate.value = rate;
    },
    setVolume(value: number) { output.gain.setTargetAtTime(value, ctx.currentTime, .035); },
    dispose() {
      for (const oscillator of oscillators) try { oscillator.stop(); } catch { /* Already stopped. */ }
      for (const node of extra) node.disconnect();
      refined?.disconnect(); output.disconnect(); envelope.disconnect(); analyser.disconnect();
    },
  };
}
export function designDuration(seconds: number, rate: number, first: boolean) {
  if (!first || rate === 1) return seconds / rate;
  let time = seconds / rate;
  for (let i = 0; i < 6; i++) { const decay = Math.exp(-time / .04); time -= (rate * time + (1 - rate) * .04 * (1 - decay) - seconds) / (rate + (1 - rate) * decay); }
  return time;
}
