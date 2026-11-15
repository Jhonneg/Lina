/** Exact Ethereal Companion · Refined values from lain-vocal-interface-lab-v3.html. */
export const REFINED_PRESET = Object.freeze({ voice: "af_nicole", bass: 4.5, metal: 9, room: 8, pitch: -1.2, drive: 1.35, carrier: 68, speed: 0.95 });

export function createRefinedImpulse(ctx: BaseAudioContext) {
  const len = Math.floor(ctx.sampleRate * .45), impulse = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = impulse.getChannelData(c); let seed = 17 + c * 31;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 4294967296 * 2 - 1) * Math.pow(1 - i / len, 3) * .3;
    }
  }
  return impulse;
}

export function createRefinedGraph(ctx: AudioContext, impulse: AudioBuffer, volume = 1) {
  const gain = (value: number) => { const node = ctx.createGain(); node.gain.value = value; return node; };
  const low = ctx.createBiquadFilter(); low.type = "lowshelf"; low.frequency.value = 190;
  const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 65;
  const high = ctx.createBiquadFilter(); high.type = "peaking"; high.frequency.value = 2700; high.Q.value = .8; high.gain.value = -1;
  const dry = gain(1), ring = gain(0), wet = gain(0), sum = gain(1), direct = gain(1), room = gain(0);
  const conv = ctx.createConvolver(), osc = ctx.createOscillator(); osc.frequency.value = 46;
  conv.buffer = impulse;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -19; comp.ratio.value = 2.5; comp.attack.value = .004; comp.release.value = .12;
  const master = gain(.75), output = gain(volume), an = ctx.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = .65;
  hp.connect(low); low.connect(high); high.connect(dry); high.connect(ring); ring.connect(wet); dry.connect(sum); wet.connect(sum);
  sum.connect(direct); sum.connect(conv); conv.connect(room); direct.connect(comp); room.connect(comp); comp.connect(master);
  // Unity output gain preserves the reference master while allowing independent volume.
  master.connect(output); output.connect(an); an.connect(ctx.destination); osc.connect(ring.gain);
  const nodes = [hp, low, high, dry, ring, wet, sum, direct, room, conv, osc, comp, master, output, an];
  let disconnected = false;
  function disconnect() {
    if (disconnected) return; disconnected = true;
    try { osc.stop(); } catch { /* May not have started. */ }
    for (const node of nodes) node.disconnect();
  }
  try { osc.start(); } catch (error) { disconnect(); throw error; }
  return { hp, low, high, dry, ring, wet, sum, direct, room, conv, osc, comp, master, output, an, disconnect,
    apply(source: AudioBufferSourceNode, playbackAt = ctx.currentTime) {
      const t = ctx.currentTime;
      for (const [parameter, value] of [
        [low.gain, REFINED_PRESET.bass], [dry.gain, 1 - REFINED_PRESET.metal / 100], [wet.gain, REFINED_PRESET.metal / 100],
        [room.gain, REFINED_PRESET.room / 100], [direct.gain, 1 - REFINED_PRESET.room / 100], [osc.frequency, REFINED_PRESET.carrier],
      ] as const) parameter.setTargetAtTime(value, t, .035);
      source.playbackRate.setTargetAtTime(Math.pow(2, REFINED_PRESET.pitch / 12), playbackAt, .04);
    },
  };
}

/** Invert the approved exponential pitch ramp, so adjacent buffers meet on the audio clock. */
export function refinedPlaybackDuration(seconds: number) {
  const rate = Math.pow(2, REFINED_PRESET.pitch / 12);
  let time = seconds / rate;
  for (let i = 0; i < 6; i++) {
    const decay = Math.exp(-time / .04);
    time -= (rate * time + (1 - rate) * .04 * (1 - decay) - seconds) / (rate + (1 - rate) * decay);
  }
  return time;
}
