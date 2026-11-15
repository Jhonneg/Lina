import { readFileSync } from "node:fs";
import { APPROVED_VOICE_PRESET } from "../../src/lib/cloud-voice/approved-preset";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DESIGN_REFINED, DESIGN_ORIGINAL, DELIVERY_DEFAULT, loadDesignPresets, parseDesignPreset, saveDesignPreset, type DesignPreset } from "../../src/lib/cloud-voice/design-presets";
import { createDesignGraph, designDuration } from "../../src/lib/cloud-voice/design-dsp";
import { DesignVoicePlayer } from "../../src/lib/cloud-voice/design-player";
import { DesignAudioCache } from "../../src/lib/cloud-voice/design-cache";
import { refinedPlaybackDuration } from "../../src/lib/voice/refined";
import { streamCloudVoice } from "../../src/lib/cloud-voice/stream";

const preset: DesignPreset = { version: 1, name: "Quiet companion", voice: "shimmer", delivery: DELIVERY_DEFAULT, effects: { ...DESIGN_REFINED } };
test("presets round-trip as bounded JSON, save locally and never contain audio or narration text", () => {
  const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  assert.deepEqual(parseDesignPreset(JSON.parse(JSON.stringify(preset))), preset);
  saveDesignPreset(storage, preset); assert.deepEqual(loadDesignPresets(storage), [preset]);
  for (let i = 0; i < 20; i++) saveDesignPreset(storage, { ...preset, name: `Preset ${i}` }); assert.equal(loadDesignPresets(storage).length, 12);
  for (const invalid of [{ ...preset, voice: "invalid" }, { ...preset, audio: "never" }, { ...preset, effects: { ...preset.effects, mode: "custom", constructor: {} } }, { ...preset, delivery: "x".repeat(1201) }, { ...preset, effects: { ...preset.effects, bass: 100 } }, { ...preset, effects: { ...preset.effects, mode: "custom", pitch: NaN } }, { ...preset, effects: { ...preset.effects, doubling: 4 } }]) assert.throws(() => parseDesignPreset(invalid));
});

test("dry audio captures commit only successful takes, are bounded and replay the identical PCM without networking", () => {
  const cache = new DesignAudioCache(), capture = cache.capture(); capture.append("AAAAAA==");
  const source = { text: "A thought.", voice: "shimmer", delivery: DELIVERY_DEFAULT, result: { generationMs: 20, estimatedCostUsd: .001, transcript: "A thought." } };
  assert.equal(cache.take, null); capture.commit(source);
  const failed = cache.capture(); failed.append("AQABAA=="); assert.deepEqual(cache.take!.chunks, ["AAAAAA=="]);
  const replay = [...cache.take!.chunks]; assert.deepEqual(replay, ["AAAAAA=="]); assert.equal(cache.take!.result.generationMs, 20);
  assert.throws(() => failed.append("A".repeat(4_000_001))); cache.clear(); assert.equal(cache.take, null);
});

class Param {
  value = 0; targets: number[][] = [];
  setTargetAtTime(...args: number[]) { this.targets.push(args); } cancelScheduledValues() {} setValueAtTime() {} linearRampToValueAtTime() {}
}
class Node {
  gain = new Param(); frequency = new Param(); Q = new Param(); threshold = new Param(); knee = new Param(); ratio = new Param(); attack = new Param(); release = new Param(); playbackRate = new Param(); delayTime = new Param();
  type = ""; fftSize = 0; smoothingTimeConstant = 0; curve?: Float32Array; buffer?: AudioBuffer; at = 0; onended: (() => void) | null = null; disconnected = false; stopped = false;
  connect() {} disconnect() { this.disconnected = true; } start(at = 0) { this.at = at; } stop() { this.stopped = true; }
}
class Context {
  state = "running"; currentTime = 1; sampleRate = 48000; destination = new Node(); nodes: Node[] = []; sources: Node[] = [];
  node = () => { const node = new Node(); this.nodes.push(node); return node; };
  createGain = this.node; createBiquadFilter = this.node; createOscillator = this.node; createConvolver = this.node; createDynamicsCompressor = this.node; createAnalyser = this.node; createDelay = this.node; createWaveShaper = this.node;
  createBufferSource() { const source = this.node(); this.sources.push(source); return source; }
  createBuffer(channels: number, length: number, sampleRate: number) { const data = Array.from({ length: channels }, () => new Float32Array(length)); return { duration: length / sampleRate, getChannelData: (index: number) => data[index] }; }
  async resume() {} async close() { this.state = "closed"; }
  asAudio() { return this as unknown as AudioContext; }
}

test("original Refined comparison retains approved ramps; custom doubling is short and the safety curve stays below clipping", () => {
  const ctx = new Context(), source = ctx.createBufferSource();
  const graph = createDesignGraph(ctx.asAudio(), DESIGN_REFINED, .8); graph.apply(source as unknown as AudioBufferSourceNode, 2, true);
  assert.deepEqual(source.playbackRate.targets, [[Math.pow(2, -1.2 / 12), 2, .04]]);
  assert.ok(ctx.nodes.some(node => node.type === "lowshelf" && node.gain.targets.some(target => target[0] === 4.5)));
  assert.equal(ctx.nodes.filter(node => node.curve).length, 0); graph.dispose();
  const custom = new Context(), designed = createDesignGraph(custom.asAudio(), { ...DESIGN_REFINED, mode: "custom", bass: 8, metal: 20, doubling: 8, room: 15 }, 1);
  const customSource = custom.createBufferSource(); designed.apply(customSource as unknown as AudioBufferSourceNode, 2, true);
  const curve = custom.nodes.find(node => node.curve)!.curve!; assert.ok([...curve].every(value => Number.isFinite(value) && Math.abs(value) < .92));
  assert.ok(custom.nodes.some(node => node.delayTime.value === .015)); designed.dispose(); assert.ok(custom.nodes.filter(node => node !== customSource).every(node => node.disconnected));
  assert.equal(designDuration(2, Math.pow(2, -1.2 / 12), true), refinedPlaybackDuration(2));
});

test("design playback keeps cached PCM ordered, exposes analysis and cleans all sources/graphs", async () => {
  const ctx = new Context(), engine = new DesignVoicePlayer(DESIGN_ORIGINAL, () => {}, () => ctx.asAudio());
  await engine.unlock(); const pcm = Buffer.alloc(4800).toString("base64"); engine.append(pcm); engine.append(pcm);
  assert.equal(ctx.sources.length, 2); assert.ok(Math.abs(ctx.sources[1].at - ctx.sources[0].at - .1) < 1e-8); assert.ok(engine.analyser);
  const finished = engine.finish(); for (const source of ctx.sources) source.onended!(); await finished; await engine.stop();
  assert.equal(engine.analyser, null); assert.equal(ctx.state, "closed"); assert.ok(ctx.sources.every(source => source.disconnected));
});

test("only lab requests carry editable delivery; the main-chat request shape stays unchanged", async () => {
  const bodies: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    bodies.push({ url: String(url), body: JSON.parse(String(options?.body)) });
    return new Response('event: done\ndata: {"generationMs":1,"estimatedCostUsd":null,"transcript":"ok"}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  };
  const signal = new AbortController().signal;
  await streamCloudVoice("A", "shimmer", signal, () => {}, fetcher, undefined, "Whisper gently.");
  await streamCloudVoice("A", "shimmer", signal, () => {}, fetcher, "id", "MUST_NOT_CHANGE_CHAT");
  assert.equal(bodies[0].body.delivery, "Whisper gently."); assert.equal(bodies[0].url, "/api/dev/cloud-voice");
  assert.deepEqual(bodies[1], { url: "/api/voice", body: { text: "A", requestId: "id" } });
});


test("approved main-chat preset exactly matches the supplied JSON and applies its DSP", () => {
  const supplied = JSON.parse(readFileSync("docs/references/lain-voice-preset.json", "utf8"));
  assert.deepEqual(APPROVED_VOICE_PRESET, supplied);
  assert.deepEqual(APPROVED_VOICE_PRESET.effects, { mode: "custom", bass: 4, metal: 6, room: 12, pitch: -1.5, carrier: 55, doubling: 7 });
  const ctx = new Context(), graph = createDesignGraph(ctx.asAudio(), { ...APPROVED_VOICE_PRESET.effects }, 1), source = ctx.createBufferSource();
  graph.apply(source as unknown as AudioBufferSourceNode, 2, true);
  assert.equal(graph.rate, Math.pow(2, -1.5 / 12));
  for (const target of [4, .94, .06, 55, .12 * .93, .88 * .93]) assert.ok(ctx.nodes.some(node => [node.gain, node.frequency].some(parameter => parameter.targets.some(args => Math.abs(args[0] - target) < 1e-10))), String(target));
  assert.ok(ctx.nodes.some(node => node.gain.value === .07)); graph.dispose();
});

test("progressive PCM seams flush partial buffers and retain the same clock, analyser and pitch envelope", async () => {
  const ctx = new Context(), engine = new DesignVoicePlayer({ ...APPROVED_VOICE_PRESET.effects }, () => {}, () => ctx.asAudio()); await engine.unlock(); engine.beginSegment();
  const half = Buffer.alloc(2400).toString("base64"); engine.append(half); assert.equal(ctx.sources.length, 0);
  engine.endSegment(); assert.equal(ctx.sources.length, 1); const analyser = engine.analyser;
  engine.append(half); engine.endSegment(); assert.equal(ctx.sources.length, 2); assert.equal(engine.analyser, analyser);
  const firstDuration = designDuration(.05, Math.pow(2, -1.5 / 12), true);
  assert.ok(Math.abs(ctx.sources[1].at - ctx.sources[0].at - firstDuration) < 1e-9);
  assert.equal(ctx.sources[1].playbackRate.value, Math.pow(2, -1.5 / 12)); assert.equal(ctx.sources[1].playbackRate.targets.length, 0);
  const finished = engine.finish(); for (const source of ctx.sources) source.onended!(); await finished; await engine.stop();
  assert.equal(engine.analyser, null); assert.ok(ctx.nodes.every(node => node.disconnected));
});
