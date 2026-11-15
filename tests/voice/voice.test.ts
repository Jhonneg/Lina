import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { VoiceEngine } from "../../src/lib/voice/engine";
import { createRefinedGraph, createRefinedImpulse, refinedPlaybackDuration, REFINED_PRESET } from "../../src/lib/voice/refined";
import { createKokoroProvider } from "../../src/lib/voice/kokoro-provider";
import { createKokoroSynthesis, KOKORO_MODEL } from "../../src/lib/voice/kokoro-synthesis";
import { VoiceError, type SpeechProvider, type WorkerResponse } from "../../src/lib/voice/types";

class Parameter {
  value = 0; targets: number[][] = [];
  setTargetAtTime(...args: number[]) { this.targets.push(args); }
}
class Node {
  gain = new Parameter(); frequency = new Parameter(); Q = new Parameter(); threshold = new Parameter(); ratio = new Parameter(); attack = new Parameter(); release = new Parameter(); playbackRate = new Parameter();
  type = ""; fftSize = 0; smoothingTimeConstant = 0; buffer: unknown; connections: unknown[] = []; disconnected = false; started = 0; stopped = 0; startTimes: number[] = [];
  onended: (() => void) | null = null;
  connect(other: unknown) { this.connections.push(other); }
  disconnect() { this.disconnected = true; }
  start(at = 0) { this.started++; this.startTimes.push(at); }
  stop() { this.stopped++; }
}
class Context {
  sampleRate = 48000; currentTime = 2; state = "suspended"; nodes: Node[] = []; destination = new Node(); sources: Node[] = []; resumes = 0; closes = 0; failResume = false; failStart = false;
  node() { const node = new Node(); this.nodes.push(node); return node; }
  createGain = () => this.node(); createBiquadFilter = () => this.node(); createConvolver = () => this.node(); createOscillator = () => this.node(); createDynamicsCompressor = () => this.node(); createAnalyser = () => this.node();
  createBufferSource() { const source = this.node(); this.sources.push(source); if (this.failStart) source.start = () => { throw Error("PRIVATE_AUDIO_ERROR"); }; return source; }
  createBuffer(channels: number, length: number, sampleRate: number) { const data = Array.from({ length: channels }, () => new Float32Array(length)); return { numberOfChannels: channels, length, sampleRate, getChannelData: (channel: number) => data[channel] }; }
  async decodeAudioData(data: ArrayBuffer) { assert.ok(data.byteLength > 0); return this.createBuffer(1, 240, 24000) as AudioBuffer; }
  async resume() { this.resumes++; if (this.failResume) throw Error("Blocked"); this.state = "running"; }
  async close() { this.closes++; this.state = "closed"; }
  asAudio() { return this as unknown as AudioContext; }
}
function provider(): SpeechProvider & { calls: number; disposed: number } {
  return { calls: 0, disposed: 0, async generate(_text, options) { this.calls++; options?.onProgress?.({ phase: "generating" }); return new ArrayBuffer(8); }, dispose() { this.disposed++; } };
}
const abortError = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

test("Refined graph and parameter ramps match the approved source, including ring modulation and pitch", () => {
  const html = readFileSync("docs/references/lain-vocal-interface-lab-v3.html", "utf8");
  const refContext = new Context(), context = new Context();
  const settings = { ...REFINED_PRESET };
  const source = context.createBufferSource(), refSource = refContext.createBufferSource();
  const reference = runInNewContext(html.match(/function gain\(v\)[\s\S]*?(?=\nfunction disconnect)/)![0] + "\n" +
    html.match(/function makeGraph\(\)[\s\S]*?(?=\nasync function play)/)![0] + "\nvar graph=makeGraph();apply();graph;", {
      ctx: refContext, settings, source: refSource, impulse: null,
    });
  const graph = createRefinedGraph(context.asAudio(), null as unknown as AudioBuffer); graph.apply(source as unknown as AudioBufferSourceNode);
  for (const key of ["hp", "low", "high", "dry", "ring", "wet", "sum", "direct", "room", "osc", "comp", "master", "an"] as const) {
    const node = graph[key] as unknown as Node, ref = reference[key] as Node;
    assert.equal(node.type, ref.type); assert.equal(node.fftSize, ref.fftSize); assert.equal(node.smoothingTimeConstant, ref.smoothingTimeConstant);
    for (const name of ["gain", "frequency", "Q", "threshold", "ratio", "attack", "release"] as const) {
      assert.equal(node[name].value, ref[name].value);
      assert.equal(JSON.stringify(node[name].targets), JSON.stringify(ref[name].targets));
    }
  }
  assert.deepEqual(source.playbackRate.targets, refSource.playbackRate.targets);
  assert.ok((graph.osc as unknown as Node).connections.includes(graph.ring.gain));
  assert.equal(graph.master.gain.value, .75); assert.equal(graph.output.gain.value, 1);
  assert.deepEqual((graph.output as unknown as Node).connections, [graph.an]);
  graph.disconnect(); graph.disconnect();
  assert.equal((graph.osc as unknown as Node).stopped, 1); assert.ok(context.nodes.slice(1).every(node => node.disconnected));
});

test("deterministic stereo reverb impulse exactly matches the reference formula at the context sample rate", () => {
  const context = new Context(), impulse = createRefinedImpulse(context.asAudio());
  const html = readFileSync("docs/references/lain-vocal-interface-lab-v3.html", "utf8");
  const original = html.match(/const len=Math.floor\(ctx.sampleRate\*\.45\);impulse=[\s\S]*?(?=\}await ctx.resume)/)![0];
  const reference = runInNewContext("let impulse;" + original + ";impulse", { ctx: context });
  assert.equal(impulse.length, 21600); assert.equal(impulse.numberOfChannels, 2);
  for (let channel = 0; channel < 2; channel++) assert.deepEqual(impulse.getChannelData(channel), reference.getChannelData(channel));
});

test("generation is lazy, reusable, decoded without autoplay, and playback exposes analysis/volume", async () => {
  const context = new Context(), speech = provider(), engine = new VoiceEngine({ provider: speech, contextFactory: () => context.asAudio() });
  assert.equal(speech.calls, 0); assert.equal(context.resumes, 0); assert.equal(engine.analyser, null);
  const audio = await engine.generate("Hello"); await engine.generate("Again");
  assert.equal(speech.calls, 2); assert.equal(context.resumes, 0); assert.equal(engine.state, "idle");
  engine.setVolume(.5); await engine.play(audio);
  assert.equal(engine.state, "playing"); assert.equal(engine.analyser!.fftSize, 2048);
  assert.equal(context.nodes.filter(node => node.gain.value === .5).length, 1);
  engine.setVolume(.2); assert.equal(engine.getVolume(), .2);
  assert.ok(context.nodes.some(node => node.gain.targets.some(target => target[0] === .2)));
  context.sources[0].onended!(); assert.equal(engine.state, "idle"); assert.equal(engine.analyser, null);
  assert.ok(context.nodes.every(node => node.disconnected));
  await engine.dispose(); await engine.dispose(); assert.equal(context.closes, 1); assert.equal(speech.disposed, 1);
  await assert.rejects(engine.generate("Disposed"), error => error instanceof VoiceError && error.code === "disposed");
});

test("stop/cancellation prevent late generation playback and clean a live signal and graph", async () => {
  const context = new Context(); let resolve!: (audio: ArrayBuffer) => void, entered!: () => void;
  const generating = new Promise<void>(r => { entered = r; });
  const speech: SpeechProvider = { generate: () => new Promise(r => { resolve = r; entered(); }), dispose() {} };
  const engine = new VoiceEngine({ provider: speech, contextFactory: () => context.asAudio() });
  const pending = engine.speak("Pending"); await generating;
  engine.stop(); resolve(new ArrayBuffer(8)); await assert.rejects(pending, abortError);
  assert.equal(context.sources.length, 0); assert.equal(engine.state, "idle");
  const audio = await context.decodeAudioData(new ArrayBuffer(8)), controller = new AbortController();
  await engine.play(audio, controller.signal); controller.abort();
  assert.equal(engine.state, "idle"); assert.equal(context.sources[0].stopped, 1); assert.equal(engine.analyser, null);
  await engine.dispose();
});

test("autoplay rejection, provider/decode/start failures, and invalid inputs are recoverable", async () => {
  const context = new Context(), speech = provider(), engine = new VoiceEngine({ provider: speech, contextFactory: () => context.asAudio() });
  context.failResume = true;
  await assert.rejects(engine.speak("Blocked"), error => error instanceof VoiceError && error.code === "autoplay");
  assert.equal(speech.calls, 0); assert.equal(engine.state, "error");
  context.failResume = false; context.failStart = true;
  await assert.rejects(engine.speak("Broken playback"), error => error instanceof VoiceError && error.code === "playback" && !error.message.includes("PRIVATE"));
  assert.equal(engine.analyser, null); assert.ok(context.nodes.every(node => node.disconnected));
  context.failStart = false; await engine.speak("Retry"); engine.stop();
  for (const text of ["", " ", "x".repeat(4001)]) await assert.rejects(engine.generate(text), VoiceError);
  for (const volume of [-1, 2, NaN]) assert.throws(() => engine.setVolume(volume), VoiceError);
  await engine.dispose();
});

class FakeWorker extends EventTarget {
  sent: { id: number; text: string }[] = []; terminated = 0;
  postMessage(value: { id: number; text: string }) { this.sent.push(value); }
  terminate() { this.terminated++; }
  emit(data: WorkerResponse) { this.dispatchEvent(new MessageEvent("message", { data })); }
  asWorker() { return this as unknown as Worker; }
}

test("worker provider is lazy, reuses a worker, isolates stale replies and terminates on abort/disposal", async () => {
  const workers: FakeWorker[] = [];
  const speech = createKokoroProvider(() => { const worker = new FakeWorker(); workers.push(worker); return worker.asWorker(); });
  assert.equal(workers.length, 0);
  const first = speech.generate("Hello"), worker = workers[0], id = worker.sent[0].id;
  worker.emit({ id: id + 1, kind: "audio", audio: new ArrayBuffer(1) });
  worker.emit({ id, kind: "audio", audio: new ArrayBuffer(8) }); assert.equal((await first).byteLength, 8);
  const controller = new AbortController(), cancelled = speech.generate("Cancel", { signal: controller.signal });
  assert.equal(workers.length, 1); await assert.rejects(speech.generate("Concurrent"), error => error instanceof VoiceError && error.code === "busy");
  controller.abort(); await assert.rejects(cancelled, abortError); assert.equal(worker.terminated, 1);
  const next = speech.generate("Restart"), fresh = workers[1];
  fresh.emit({ id: fresh.sent[0].id, kind: "error", code: "loading" }); await assert.rejects(next, VoiceError);
  const last = speech.generate("Dispose"); speech.dispose(); await assert.rejects(last, abortError);
  assert.ok(workers.every(worker => worker.terminated >= 1));
});

test("Kokoro initialization is single-flight and uses exact Nicole/model/speed/WAV settings", async () => {
  let loads = 0, initializations = 0; const calls: unknown[] = [];
  const load = async () => { loads++; return { KokoroTTS: { async from_pretrained(model: string, options: Record<string, unknown>) {
    initializations++; assert.equal(model, KOKORO_MODEL); assert.equal(options.dtype, "q8"); assert.equal(options.device, "wasm");
    return { async generate(text: string, options: unknown) { calls.push({ text, options }); return { audio: new Float32Array(24000), sampling_rate: 24000, toBlob: () => new Blob([new Uint8Array([1, 2, 3])]) }; } };
  } } }; };
  const synthesize = createKokoroSynthesis(load as unknown as Parameters<typeof createKokoroSynthesis>[0]);
  const progress: string[] = [];
  assert.equal((await synthesize("First", event => progress.push(event.phase))).byteLength, 3);
  await synthesize("Second", () => {});
  assert.equal(loads, 1); assert.equal(initializations, 1);
  assert.deepEqual(calls, [{ text: "First", options: { voice: "af_nicole", speed: .95 } }, { text: "Second", options: { voice: "af_nicole", speed: .95 } }]);
  assert.deepEqual(progress, ["loading", "generating"]);
  let retries = 0;
  const failed = createKokoroSynthesis(async () => { retries++; throw Error("PRIVATE"); });
  for (let i = 0; i < 2; i++) await assert.rejects(failed("Try", () => {}), error => error instanceof VoiceError && error.code === "loading" && !error.message.includes("PRIVATE"));
  assert.equal(retries, 2);
});

test("generation/decode failures sanitize errors, preserve retries, and pre-aborted calls start no work", async () => {
  const context = new Context(), speech = provider(); let fail = true;
  const generate = speech.generate.bind(speech);
  speech.generate = async (text, options) => { if (fail) { fail = false; throw new VoiceError("generation", "Speech generation failed."); } return generate(text, options); };
  const engine = new VoiceEngine({ provider: speech, contextFactory: () => context.asAudio() });
  await assert.rejects(engine.generate("Fail"), error => error instanceof VoiceError && error.code === "generation");
  assert.equal(engine.state, "error"); assert.equal(context.sources.length, 0);
  const decode = context.decodeAudioData.bind(context);
  context.decodeAudioData = async () => { throw Error("PRIVATE_DECODE_ERROR"); };
  await assert.rejects(engine.generate("Bad data"), error => error instanceof VoiceError && error.code === "playback" && !error.message.includes("PRIVATE"));
  context.decodeAudioData = decode; await engine.generate("Retry"); assert.equal(engine.state, "idle");
  const calls = speech.calls, controller = new AbortController(); controller.abort();
  await assert.rejects(engine.generate("Cancelled", { signal: controller.signal }), abortError);
  assert.equal(speech.calls, calls); assert.equal(engine.state, "idle");
  await engine.dispose();
});

test("one preparation can overlap playback and survives natural endings/next starts without model cancellation", async () => {
  const context = new Context(); let resolve!: (audio: ArrayBuffer) => void, signal: AbortSignal | undefined;
  const speech: SpeechProvider = { generate(_text, options) {
    signal = options?.signal;
    return new Promise((done, reject) => { resolve = done; signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true }); });
  }, dispose() {} };
  const engine = new VoiceEngine({ provider: speech, contextFactory: () => context.asAudio() }); await engine.unlock();
  const first = engine.prepare("First"); resolve(new ArrayBuffer(8)); const audio = await first; await engine.play(audio);
  const next = engine.prepare("Second"); const preparedSignal = signal;
  await assert.rejects(engine.prepare("Parallel model request"), error => error instanceof VoiceError && error.code === "busy");
  context.sources[0].onended!(); assert.equal(preparedSignal?.aborted, false);
  resolve(new ArrayBuffer(8)); const second = await next;
  const future = engine.prepare("Third"), futureSignal = signal;
  await engine.play(second); assert.equal(futureSignal?.aborted, false); assert.ok(engine.analyser);
  engine.stop(); await assert.rejects(future, abortError); assert.equal(futureSignal?.aborted, true); assert.equal(engine.analyser, null);
  await engine.dispose();
});

test("queued buffers share the approved DSP and meet on the audio clock without waiting for JS ended callbacks", async () => {
  const ctx = new Context(), engine = new VoiceEngine({ provider: provider(), contextFactory: () => ctx.asAudio() });
  const signal = new AbortController(), audio = { duration: 2 } as AudioBuffer, ended: number[] = [];
  await engine.enqueue(audio, signal.signal, () => ended.push(1));
  const analyser = engine.analyser;
  await engine.enqueue(audio, signal.signal, () => ended.push(2));
  const first = ctx.sources[0], second = ctx.sources[1];
  assert.equal(first.startTimes[0], ctx.currentTime);
  assert.equal(second.startTimes[0], first.startTimes[0] + refinedPlaybackDuration(2));
  assert.equal(second.playbackRate.targets[0][1], second.startTimes[0]);
  assert.equal(engine.analyser, analyser);
  await assert.rejects(engine.enqueue(audio, signal.signal, () => {}), error => error instanceof VoiceError && error.code === "busy");
  first.onended!(); assert.equal(engine.state, "playing"); assert.equal(engine.analyser, analyser); assert.deepEqual(ended, [1]);
  second.onended!(); assert.equal(engine.state, "idle"); assert.deepEqual(ended, [1, 2]);
  const rate = Math.pow(2, REFINED_PRESET.pitch / 12), time = refinedPlaybackDuration(2);
  assert.ok(Math.abs(rate * time + (1 - rate) * .04 * (1 - Math.exp(-time / .04)) - 2) < 1e-10);
  await engine.dispose();
});

test("Stop aborts queued sources and preparation together, without invoking stale completion callbacks", async () => {
  const ctx = new Context(), speech = provider(), engine = new VoiceEngine({ provider: speech, contextFactory: () => ctx.asAudio() });
  const signal = new AbortController(), audio = { duration: 1 } as AudioBuffer;
  let ended = 0;
  await engine.enqueue(audio, signal.signal, () => ended++); await engine.enqueue(audio, signal.signal, () => ended++);
  signal.abort(); assert.equal(engine.state, "idle"); assert.equal(engine.analyser, null);
  assert.ok(ctx.sources.every(source => source.stopped === 1 && source.disconnected && !source.onended)); assert.equal(ended, 0);
  await assert.rejects(engine.enqueue(audio, signal.signal, () => ended++), abortError);
  await engine.dispose();
});

test("synthesis diagnostics measure initialization, audio duration and real-time factor without changing settings", async () => {
  const metrics: { reused: boolean; audioSeconds: number; rtf: number; inferenceMs: number }[] = [];
  const load = async () => ({ KokoroTTS: { from_pretrained: async () => ({ generate: async () => ({
    audio: new Float32Array(48000), sampling_rate: 24000, toBlob: () => new Blob([new Uint8Array([1])]),
  }) }) } });
  const synthesize = createKokoroSynthesis(load as unknown as Parameters<typeof createKokoroSynthesis>[0]);
  await synthesize("One", () => {}, metric => metrics.push(metric)); await synthesize("Two", () => {}, metric => metrics.push(metric));
  assert.deepEqual(metrics.map(metric => metric.reused), [false, true]);
  for (const metric of metrics) { assert.equal(metric.audioSeconds, 2); assert.equal(metric.rtf, metric.inferenceMs / 2000); }
});
