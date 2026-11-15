import type { AudioReactivity } from "../../lib/audio/reactivity";

type Uniform = { value: number };
export type OrbAudioUniforms = { audioRms: Uniform; audioBass: Uniform; audioMid: Uniform; audioHigh: Uniform; pulse: Uniform };

/** Updates existing uniforms and returns a bounded scale multiplier; no frame allocations. */
export function applyOrbAudio(uniforms: OrbAudioUniforms, input: AudioReactivity | null | undefined, delta: number, reduced: boolean, baselinePulse: number) {
  if (!input || reduced) {
    uniforms.audioRms.value = uniforms.audioBass.value = uniforms.audioMid.value = uniforms.audioHigh.value = 0;
    uniforms.pulse.value = baselinePulse;
    return 1;
  }
  const signal = input.sample(delta);
  uniforms.audioRms.value = signal.rms; uniforms.audioBass.value = signal.bass;
  uniforms.audioMid.value = signal.mid; uniforms.audioHigh.value = signal.treble;
  // Use real speech activity instead of stacking a full simulated Talking peak.
  uniforms.pulse.value = baselinePulse * (1 - .75 * signal.rms);
  return 1 + signal.rms * .045;
}
