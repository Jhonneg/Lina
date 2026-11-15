import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { ChatVoiceController, type ChatVoiceEngine, type VoiceFactory } from "../../src/components/chat/chat-voice-controller";
import { spokenResponse, SPEECH_LIMITS } from "../../src/components/chat/spoken-text";
import { VoiceError, type GenerationOptions, type VoiceState } from "../../src/lib/voice/types";
import type { AudioReactivity } from "../../src/lib/audio/reactivity";
import type { Message } from "../../src/components/chat/chat-types";

const message = (content = "A quiet response."): Message => ({ id: "assistant", role: "assistant", content, status: "complete" });
class Engine implements ChatVoiceEngine {
  enqueue?: ChatVoiceEngine["enqueue"];
  state: VoiceState = "idle"; stops = 0; disposals = 0; unlocked = 0; volume = 1; calls: string[] = [];
  unlockError = false; speechError = false; gate?: Promise<void>;
  constructor(private notify: (state: VoiceState) => void) {}
  get analyser() { return this.state === "playing" ? { fftSize: 2048, frequencyBinCount: 1024, context: { sampleRate: 48000, state: "running" } } as AnalyserNode : null; }
  emit(state: VoiceState) { this.state = state; this.notify(state); }
  async unlock() { this.unlocked++; if (this.gate) await this.gate; if (this.unlockError) throw new VoiceError("autoplay", "Playback blocked."); }
  played: string[] = [];
  async prepare(text: string, options: GenerationOptions = {}) { this.calls.push(text); options.onProgress?.({ phase: "generating" });
    if (this.gate) await this.gate; options.signal?.throwIfAborted(); if (this.speechError) throw new VoiceError("generation", "Model unavailable.");
    return { label: text } as unknown as AudioBuffer;
  }
  async play(audio: AudioBuffer, signal?: AbortSignal) { signal?.throwIfAborted(); this.played.push((audio as unknown as { label: string }).label); this.emit("playing"); }
  async speak(text: string, options: GenerationOptions = {}) { await this.play(await this.prepare(text, options), options.signal); }
  stop() { this.stops++; this.emit("idle"); }
  setVolume(value: number) { this.volume = value; }
  async dispose() { this.disposals++; this.emit("disposed"); }
}
function fixture(saved?: object) {
  const values = new Map<string, string>(); if (saved) values.set("lain.voice-preferences.v1", JSON.stringify(saved));
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const engines: Engine[] = [], audio: { current: AudioReactivity | null } = { current: null };
  let prepare: (engine: Engine) => void = () => {};
  const factory: VoiceFactory = options => { const engine = new Engine(state => options.onStateChange?.(state)); prepare(engine); engines.push(engine); return engine; };
  return { controller: new ChatVoiceController(factory, audio, storage), engines, audio, values, configure: (callback: (engine: Engine) => void) => { prepare = callback; } };
}

test("voice requires explicit consent and a current-visit activation; preferences never initialize a model", async () => {
  const first = fixture(); assert.equal(first.engines.length, 0); assert.equal(first.controller.view.enabled, false);
  assert.equal(await first.controller.enable(), false); assert.equal(first.engines.length, 0);
  assert.equal(await first.controller.enable(true), true); assert.equal(first.engines[0].unlocked, 1);
  assert.equal(first.controller.view.permitted, true); assert.deepEqual(first.engines[0].calls, []);
  first.controller.setVolume(.35); const saved = JSON.parse(first.values.get("lain.voice-preferences.v1")!);
  first.controller.dispose();
  const restored = fixture(saved); assert.equal(restored.controller.view.volume, .35); assert.equal(restored.controller.view.consented, true);
  assert.equal(restored.controller.view.preferredEnabled, true); assert.equal(restored.controller.view.enabled, false); assert.equal(restored.controller.view.permitted, false);
  assert.equal(restored.engines.length, 0); await restored.controller.play(message()); assert.equal(restored.engines.length, 0); restored.controller.dispose();
});

test("automatic speech follows live eligible sentences and completion, never restored history", async () => {
  const { controller, engines } = fixture(); await controller.enable(true);
  controller.observe([message()], null, null, "saved", null); assert.equal(engines[0].calls.length, 0);
  controller.observe([{ ...message(), status: "streaming" }], "request", "assistant", "saved", null); assert.equal(engines[0].calls.length, 0);
  controller.observe([message()], null, "assistant", "saved", null); await setImmediate(); assert.equal(engines[0].calls.length, 1);
  engines[0].emit("idle"); await setImmediate(); controller.observe([message()], null, "assistant", "saved", null); assert.equal(engines[0].calls.length, 1);
  controller.observe([{ ...message(), status: "streaming" }], "cancelled", "assistant", "saved", null); controller.stop();
  controller.observe([message()], "cancelled", "assistant", "saved", null); controller.observe([message()], null, "assistant", "saved", null);
  assert.equal(engines[0].calls.length, 1); controller.dispose();
});

test("manual playback serializes bounded chunks, attaches analysis only during playback and clears on completion", async () => {
  const { controller, engines, audio } = fixture(); await controller.enable(true);
  const text = 'A sentence to read. '.repeat(90), playback = controller.play(message(text)); await setImmediate();
  assert.equal(engines[0].calls.length, 2); assert.ok(audio.current); assert.equal(controller.view.messageId, "assistant");
  for (let i = 0; i < 32 && controller.view.messageId; i++) { engines[0].emit("idle"); await setImmediate(); }
  await playback; assert.ok(engines[0].calls.length > 1); assert.ok(engines[0].calls.every(chunk => chunk.length <= SPEECH_LIMITS.chunk));
  assert.equal(audio.current, null); assert.equal(controller.view.state, "idle"); assert.equal(controller.view.messageId, null); controller.dispose();
});

test("New Chat/switch/disable cancellation prevents stale results and queued chunks from playing", async () => {
  const { controller, engines, audio } = fixture(); await controller.enable(true);
  let release!: () => void; engines[0].gate = new Promise(resolve => { release = resolve; });
  const playback = controller.play(message('A long response. '.repeat(80))); await setImmediate(); controller.stop(); release(); await playback;
  assert.equal(engines[0].calls.length, 1); assert.equal(audio.current, null); assert.equal(controller.view.state, "idle");
  engines[0].gate = undefined; const active = controller.play(message()); await setImmediate();
  controller.observe([], null, null, "first", null); controller.observe([], null, null, "second", "Restoring conversation"); await active;
  assert.equal(audio.current, null); assert.equal(controller.view.messageId, null);
  controller.disable(); assert.equal(controller.view.enabled, false); assert.equal(engines[0].disposals, 1); controller.dispose();
});

test("late activation after disable cannot reenable speech or retain resources", async () => {
  const f = fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  f.configure(engine => { engine.gate = gate; }); const activation = f.controller.enable(true); f.controller.disable(); release();
  assert.equal(await activation, false); assert.equal(f.controller.view.enabled, false); assert.equal(f.engines[0].disposals, 1); assert.equal(f.engines[0].calls.length, 0); f.controller.dispose();
});

test("autoplay/model failures and missing speech text remain recoverable without touching chat messages", async () => {
  const f = fixture(); f.configure(engine => { engine.unlockError = true; }); assert.equal(await f.controller.enable(true), false);
  assert.equal(f.controller.view.permitted, false); assert.ok(f.controller.view.error); assert.equal(f.engines[0].disposals, 1);
  f.configure(() => {}); await f.controller.enable(); const engine = f.engines.at(-1)!; engine.speechError = true;
  const original = message(); await f.controller.play(original); assert.equal(original.content, "A quiet response."); assert.equal(original.status, "complete"); assert.ok(f.controller.view.error);
  engine.speechError = false; await f.controller.play(message('```js\nthrow Error("not spoken");\n```'));
  assert.equal(f.controller.view.notice, "Nothing to read aloud. Code blocks are skipped."); assert.equal(engine.calls.length, 1);
  f.controller.dispose(); assert.equal(f.audio.current, null);
});

test("spoken Markdown skips fenced code/HTML and destinations while retaining meaningful labels and lists", () => {
  const plan = spokenResponse('# A **clear** thought\n\n[Reference](https://example.com/private) and `value`.\n\n- First\n- ~~Second~~\n\n```js\nNEVER_READ_THIS()\n```\n\n<script>NEVER_READ_HTML</script>\n\n| Name | Value |\n| --- | --- |\n| A | B |');
  const text = plan.chunks.join(' '); assert.ok(text.includes('A clear thought') && text.includes('Reference and value.') && text.includes('First Second') && text.includes('Name Value A B'));
  for (const unwanted of ['NEVER_READ', 'https://', '**', '```', '<script>', '| ---']) assert.ok(!text.includes(unwanted), unwanted);
  assert.equal(spokenResponse('Before\n\n```python\nAn unclosed fence').chunks.join(' '), 'Before');
});

test("long spoken responses have bounded total/chunk counts and preserve Unicode boundaries", () => {
  const long = spokenResponse('A sentence. '.repeat(1000)); assert.ok(long.truncated); assert.ok(long.chunks.length <= 8);
  assert.ok(long.chunks.every(chunk => chunk.length <= 600)); assert.ok(long.chunks.reduce((sum, chunk) => sum + chunk.length, 0) <= 4000);
  const unicode = spokenResponse('x' + '🌙'.repeat(4000)); assert.ok(unicode.chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk)));
});

test("progressive speech prefetches one segment during playback and completion/reconciliation never duplicate it", async () => {
  const { controller, engines } = fixture(); await controller.enable(true);
  const update = (content: string, done = false) => controller.observe([{ ...message(content), status: done ? "complete" : "streaming" }], done ? null : "stream", "assistant", "saved", null);
  update("You are connected. "); await setImmediate();
  assert.deepEqual(engines[0].played, ["You are connected."]);
  update("You are connected. I am Lain. "); await setImmediate();
  assert.deepEqual(engines[0].calls, ["You are connected.", "I am Lain."]);
  assert.equal(engines[0].played.length, 1); // Synthesized ahead, never overlapped audio.
  update("You are connected. I am Lain. A final thought", true); await setImmediate();
  engines[0].emit("idle"); await setImmediate(); assert.equal(engines[0].played[1], "I am Lain.");
  engines[0].emit("idle"); await setImmediate(); assert.equal(engines[0].played[2], "A final thought");
  engines[0].emit("idle"); await setImmediate();
  update("You are connected. I am Lain. A final thought", true);
  controller.observe([message("You are connected. I am Lain. A final thought")], "retry", "assistant", "saved", null);
  update("You are connected. I am Lain. A final thought", true); await setImmediate();
  assert.equal(engines[0].played.length, 3); assert.equal(controller.view.state, "idle"); controller.dispose();
});

test("queue backpressure bounds prepared audio and cancellation discards prefetch and buffered sentences", async () => {
  const { controller, engines, audio } = fixture(); await controller.enable(true);
  const content = Array.from({ length: 150 }, (_, i) => `A thoughtful sentence number ${i}.`).join(" ");
  controller.observe([{ ...message(content + " "), status: "streaming" }], "busy", "assistant", "saved", null); await setImmediate();
  assert.equal(engines[0].calls.length, 2); assert.equal(engines[0].played.length, 1);
  controller.stop(); engines[0].emit("idle"); await setImmediate();
  assert.equal(engines[0].played.length, 1); assert.equal(audio.current, null);
  controller.observe([message(content)], null, "assistant", "saved", null); await setImmediate();
  assert.equal(engines[0].played.length, 1); controller.dispose();
});

test("audio-clock scheduling stays bounded, preserves all eligible text in order and ignores stale callbacks after Stop", async () => {
  const f = fixture(), callbacks: (() => void)[] = [];
  f.configure(engine => {
    engine.enqueue = async (audio, signal, ended) => {
      signal.throwIfAborted(); engine.played.push((audio as unknown as { label: string }).label);
      callbacks.push(ended); if (engine.state !== "playing") engine.emit("playing");
    };
  });
  await f.controller.enable(true);
  const content = "A complete thought with foo_bar and 2 < 3. ".repeat(45);
  const pending = f.controller.play(message(content)); await setImmediate();
  assert.equal(callbacks.length, 2); assert.equal(f.engines[0].calls.length, 3); // two scheduled plus one ready
  for (let i = 0; i < 40 && callbacks.length; i++) {
    const callback = callbacks.shift()!;
    if (!callbacks.length) f.engines[0].emit("idle"); callback(); await setImmediate();
    assert.ok(callbacks.length <= 2);
  }
  await pending;
  assert.equal(f.engines[0].played.join(" "), content.trim());
  assert.deepEqual(f.engines[0].played, f.engines[0].calls);
  const cancelled = f.controller.play(message(content)); await setImmediate();
  f.controller.stop(); const played = f.engines[0].played.length;
  for (const ended of callbacks.splice(0)) ended(); await cancelled; await setImmediate();
  assert.equal(f.engines[0].played.length, played); assert.equal(f.controller.view.state, "idle"); f.controller.dispose();
});
