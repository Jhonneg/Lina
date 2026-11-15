import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { createRefinedGraph, createRefinedImpulse, REFINED_PRESET } from "../../src/lib/voice/refined";

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

