import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { CloudVoicePlayer } from "../../src/lib/cloud-voice/player";
import { streamCloudVoice } from "../../src/lib/cloud-voice/stream";
import { REFINED_PRESET, refinedPlaybackDuration } from "../../src/lib/voice/refined";

class Param { value = 0; ramps: number[][] = []; setTargetAtTime(...args: number[]) { this.ramps.push(args); } }
class Node {
  gain = new Param(); frequency = new Param(); Q = new Param(); threshold = new Param(); ratio = new Param(); attack = new Param(); release = new Param(); playbackRate = new Param();
  fftSize = 0; smoothingTimeConstant = 0; type = ""; buffer?: AudioBuffer; onended: (() => void) | null = null; stopped = false; disconnected = false; at = -1;
  connect() {} disconnect() { this.disconnected = true; } start(at = 0) { this.at = at; } stop() { this.stopped = true; }
}
class Context {
  state = "suspended"; sampleRate = 48000; currentTime = 1; destination = new Node(); sources: Node[] = []; nodes: Node[] = [];
  node = () => { const value = new Node(); this.nodes.push(value); return value; };
  createGain = this.node; createBiquadFilter = this.node; createConvolver = this.node; createOscillator = this.node; createDynamicsCompressor = this.node; createAnalyser = this.node;
  createBufferSource() { const source = this.node(); this.sources.push(source); return source; }
  createBuffer(channels: number, length: number, sampleRate: number) { const data = Array.from({ length: channels }, () => new Float32Array(length)); return { duration: length / sampleRate, getChannelData: (index: number) => data[index] }; }
  async resume() { this.state = "running"; } async close() { this.state = "closed"; }
  asAudio() { return this as unknown as AudioContext; }
}
const pcm = Buffer.alloc(4800).toString("base64");

test("PCM playback batches tiny deltas, schedules adjacent samples continuously and drains the final partial buffer", async () => {
  const context = new Context(), states: boolean[] = [];
  const player = new CloudVoicePlayer(false, state => states.push(state), () => context.asAudio());
  await player.unlock(); player.setVolume(.4);
  player.append(Buffer.alloc(2400).toString("base64")); assert.equal(context.sources.length, 0);
  player.append(Buffer.alloc(2400).toString("base64")); player.append(pcm);
  assert.equal(context.sources.length, 2); assert.ok(Math.abs(context.sources[1].at - context.sources[0].at - .1) < 1e-9);
  assert.equal(player.analyser!.fftSize, 2048); assert.equal(context.sources[0].playbackRate.value, 1);
  player.append(Buffer.alloc(24).toString("base64")); const finished = player.finish(); assert.equal(context.sources.length, 3);
  for (const source of context.sources) source.onended!(); await finished; await player.stop();
  assert.equal(player.analyser, null); assert.equal(context.state, "closed");
});

test("Refined uses the existing DSP, continuous pitch rate, volume and analyser; Stop discards scheduled audio", async () => {
  const ctx = new Context(), player = new CloudVoicePlayer(true, () => {}, () => ctx.asAudio());
  await player.unlock(); player.append(pcm); const analyser = player.analyser; player.append(pcm);
  assert.equal(player.analyser, analyser);
  assert.ok(Math.abs(ctx.sources[1].at - ctx.sources[0].at - refinedPlaybackDuration(.1)) < 1e-9);
  assert.equal(ctx.sources[1].playbackRate.value, Math.pow(2, REFINED_PRESET.pitch / 12));
  assert.equal(ctx.sources[0].playbackRate.ramps[0][2], .04); assert.ok(ctx.nodes.some(node => node.type === "highpass" && node.frequency.value === 65));
  player.setVolume(.2); assert.ok(ctx.nodes.some(node => node.gain.ramps.some(ramp => ramp[0] === .2)));
  const finished = player.finish(); await player.stop(); await finished;
  assert.ok(ctx.sources.every(source => source.stopped && source.disconnected && source.onended === null));
  const count = ctx.sources.length; player.append(pcm); assert.equal(ctx.sources.length, count);
});

test("cloud stream parser handles byte-fragmented UTF-8, multiple events and progressive audio before done", async () => {
  const audio: string[] = [], controller = new AbortController(); let end!: () => void;
  const gate = new Promise<void>(resolve => { end = resolve; });
  const fetcher: typeof fetch = async (_url, options) => {
    assert.equal(options?.credentials, "same-origin"); assert.equal(JSON.parse(String(options?.body)).confirmed, true);
    return new Response(new ReadableStream({ async start(stream) {
      const encoder = new TextEncoder();
      for (const byte of encoder.encode('event: audio\r\ndata: {"pcm":"AAAAAA==","sampleRate":24000}\r\n\r\n')) stream.enqueue(new Uint8Array([byte]));
      await gate;
      const text = 'event: done\ndata: {"generationMs":12,"estimatedCostUsd":0.001,"transcript":"Lain 🌙"}\n\n';
      for (const byte of encoder.encode(text)) stream.enqueue(new Uint8Array([byte])); stream.close();
    } }), { headers: { "Content-Type": "text/event-stream" } });
  };
  const pending = streamCloudVoice("Sample", "coral", controller.signal, value => audio.push(value), fetcher);
  await setImmediate(); assert.deepEqual(audio, ["AAAAAA=="]); end(); assert.equal((await pending).transcript, "Lain 🌙");
});

test("stream errors, unexpected EOF, invalid formats and cancellation are recoverable and cancel the reader", async () => {
  for (const frame of ['event: error\ndata: {"code":"FAILED"}\n\n', 'event: audio\ndata: {"pcm":"AA==","sampleRate":1}\n\n', 'event: audio\ndata: {"pcm":"AAAAAA==","sampleRate":24000}\n\n']) {
    const fetcher: typeof fetch = async () => new Response(frame, { headers: { "Content-Type": "text/event-stream" } });
    await assert.rejects(streamCloudVoice("a", "marin", new AbortController().signal, () => {}, fetcher));
  }
  let cancelled = false;
  const controller = new AbortController(), fetcher: typeof fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "text/event-stream" } });
  const pending = streamCloudVoice("a", "marin", controller.signal, () => {}, fetcher); await setImmediate(); controller.abort();
  await assert.rejects(pending, error => error instanceof DOMException && error.name === "AbortError"); assert.equal(cancelled, true);
  const error: typeof fetch = async () => Response.json({ error: { message: "Set the server key." } }, { status: 503 });
  await assert.rejects(streamCloudVoice("a", "marin", new AbortController().signal, () => {}, error), /Set the server key/);
});

test("cloud lab imports no Kokoro loader/worker and requests no microphone", () => {
  for (const file of ["src/components/voice/cloud-voice-lab.tsx", "src/lib/cloud-voice/player.ts", "src/lib/cloud-voice/stream.ts"]) {
    const source = readFileSync(file, "utf8"); assert.ok(!/getUserMedia|kokoro-js|createVoiceEngine|voice\/index|kokoro\.worker/.test(source));
  }
  const page = readFileSync("src/app/dev/cloud-voice/page.tsx", "utf8"); assert.ok(page.includes('process.env.NODE_ENV !== "development"'));
});
