import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { CloudChatVoiceController } from "../../src/components/chat/cloud-chat-voice-controller";
import type { DesignVoicePlayer } from "../../src/lib/cloud-voice/design-player";
import type { streamCloudVoice } from "../../src/lib/cloud-voice/stream";
import type { Message } from "../../src/components/chat/chat-types";

const message = (content = "A **quiet** thought."): Message => ({ id: "assistant", role: "assistant", status: "complete", content });
class Player {
  resets = 0; stops = 0; unlocks = 0; volume = 1; appended: string[] = [];
  get analyser() { return { fftSize: 2048, frequencyBinCount: 1024, context: { state: "running", sampleRate: 48000 } } as AnalyserNode; }
  async unlock() { this.unlocks++; } reset() { this.resets++; } async stop() { this.stops++; }
  beginSegment() {} endSegment() {}
  append(value: string) { this.appended.push(value); } async finish() {}
  setVolume(value: number) { this.volume = value; }
}
function fixture(development = true) {
  const storage = new Map<string, string>(), players: Player[] = [], audio = { current: null } as ConstructorParameters<typeof CloudChatVoiceController>[0];
  const calls: { text: string; voice: string; id?: string; segment?: { index: number; final: boolean }; signal: AbortSignal; emit: (pcm: string) => void; resolve: () => void; reject: () => void }[] = [];
  let playing: (value: boolean) => void = () => {};
  const stream: typeof streamCloudVoice = (text, voice, signal, emit, _fetch, id, _delivery, segment) => new Promise((resolve, reject) => {
    calls.push({ text, voice, signal, emit, id, segment, resolve: () => resolve({ transcript: text, generationMs: 1, estimatedCostUsd: null }), reject: () => reject(Error("Failure")) });
    signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
  });
  const options = { available: development, stream, createPlayer: (notify: (value: boolean) => void) => { playing = notify; const player = new Player(); players.push(player); return player as unknown as DesignVoicePlayer; } };
  const controller = new CloudChatVoiceController(audio, { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } }, options);
  return { controller, players, calls, storage, audio, playing: (value: boolean) => playing(value) };
}

test("cloud activation is explicit, disabled by default, requires no download consent and respects explicit availability", async () => {
  const f = fixture(); assert.equal(f.controller.view.enabled, false); assert.equal(f.players.length, 0);
  await f.controller.play(message()); assert.equal(f.calls.length, 0);
  assert.equal(await f.controller.enable(), true); assert.equal(f.calls.length, 0); assert.equal(f.players.length, 1);
  f.controller.setVolume(.4); assert.equal(f.players[0].volume, .4);
  f.controller.disable(); assert.equal(f.players[0].stops, 1); assert.equal(f.controller.view.permitted, false); f.controller.dispose();
  const blocked = fixture(false); assert.equal(await blocked.controller.enable(), false); assert.equal(blocked.players.length, 0);
});

test("incomplete boundaries wait for completion; restoration and reconciliation never repeat speech", async () => {
  const f = fixture(); await f.controller.enable();
  f.controller.observe([message()], null, null, "saved", null); assert.equal(f.calls.length, 0);
  f.controller.observe([{ ...message(), status: "streaming" }], "request", "assistant", "saved", null); assert.equal(f.calls.length, 0);
  f.controller.observe([message()], null, "assistant", "saved", null); await setImmediate();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].voice, "shimmer"); assert.equal(f.calls[0].text, "A quiet thought.");
  f.controller.observe([message()], null, "assistant", "saved", null);
  f.calls[0].emit("pcm"); f.playing(true); assert.ok(f.audio.current); assert.equal(f.controller.view.state, "playing");
  f.calls[0].resolve(); await setImmediate(); assert.equal(f.controller.view.state, "idle"); assert.equal(f.audio.current, null); assert.equal(f.players.length, 1);
  f.controller.observe([{ ...message(), status: "streaming" }], "retry", "assistant", "saved", null);
  f.controller.observe([message()], null, "assistant", "saved", null); assert.equal(f.calls.length, 1);
  f.controller.dispose();
});

test("manual playback preserves Markdown filtering, bounds cost, and double submissions cannot bill twice", async () => {
  const f = fixture(); await f.controller.enable();
  const content = '# A **thought**\n\n```js\nNEVER_READ\n```\n\n' + 'A clear sentence. '.repeat(80);
  const first = f.controller.play(message(content)), duplicate = f.controller.play(message(content)); await setImmediate();
  assert.equal(f.calls.length, 1); assert.ok(!f.calls[0].text.includes('NEVER_READ')); assert.ok(f.calls[0].text.length <= 800); assert.ok(f.controller.view.notice?.includes('800'));
  assert.match(f.calls[0].id!, /^[0-9a-f-]{36}$/); f.calls[0].resolve(); await first; await duplicate;
  const replay = f.controller.play(message()); await setImmediate(); assert.equal(f.calls.length, 2); assert.notEqual(f.calls[1].id, f.calls[0].id);
  f.calls[1].resolve(); await replay; f.controller.dispose();
});

test("Stop, switching, New Chat and disable abort billing/playback and reject stale PCM; failures never auto-retry", async () => {
  const f = fixture(); await f.controller.enable();
  const pending = f.controller.play(message()); await setImmediate(); f.controller.stop();
  f.calls[0].emit("STALE"); await pending; assert.ok(f.calls[0].signal.aborted); assert.deepEqual(f.players[0].appended, []);
  f.controller.observe([], null, null, "one", null);
  const switched = f.controller.play(message()); await setImmediate(); f.controller.observe([], null, null, "two", "Restoring…"); await switched;
  assert.ok(f.calls[1].signal.aborted); assert.equal(f.audio.current, null);
  f.controller.observe([{ ...message(), status: "streaming" }], "request", "assistant", "two", null);
  f.controller.observe([message()], null, "assistant", "two", null); await setImmediate();
  // Already manually handled message is not automatically replayed.
  assert.equal(f.calls.length, 2);
  const failed = f.controller.play({ ...message(), id: "other" }); await setImmediate(); f.calls[2].reject(); await failed;
  assert.ok(f.controller.view.error); assert.equal(f.controller.view.state, "error");
  const disabled = f.controller.play(message()); await setImmediate(); f.controller.disable(); await disabled;
  assert.ok(f.calls[3].signal.aborted); assert.equal(f.controller.view.enabled, false); f.controller.dispose();
});

test("saved cloud preferences preserve volume but never grant playback or local-download consent", () => {
  const controller = new CloudChatVoiceController({ current: null }, { getItem: key => {
    assert.equal(key, "lain.cloud-voice-preferences.v1"); return JSON.stringify({ version: 1, enabled: true, volume: .35, consented: true });
  }, setItem() {} }, { available: true, createPlayer: () => { throw Error("Must remain lazy"); } });
  assert.equal(controller.view.enabled, false); assert.equal(controller.view.permitted, false); assert.equal(controller.view.preferredEnabled, true);
  assert.equal(controller.view.volume, .35); assert.equal("consented" in controller.view, false); controller.dispose();
});

test("automatic narration uses the stable assistant UUID for server-side duplicate protection", async () => {
  const f = fixture(); await f.controller.enable(); const id = crypto.randomUUID();
  f.controller.observe([{ ...message(), id, status: "streaming" }], "request", id, "saved", null);
  f.controller.observe([{ ...message(), id }], null, id, "saved", null); await setImmediate();
  assert.equal(f.calls[0].id, id); f.calls[0].resolve(); await setImmediate(); f.controller.dispose();
});

test("cloud narration retains literal underscores and final unfinished emphasis without speaking Markdown syntax", async () => {
  const f = fixture(); await f.controller.enable();
  const pending = f.controller.play(message("Use foo_bar. **A final unfinished thought")); await setImmediate();
  assert.equal(f.calls[0].text, "Use foo_bar. A final unfinished thought"); f.calls[0].resolve(); await pending; f.controller.dispose();
});


test("progressive cloud speech starts before text completion, prefetches in order and flushes once", async () => {
  const f = fixture(); await f.controller.enable();
  const update = (content: string, done = false) => f.controller.observe([{ ...message(content), status: done ? "complete" : "streaming" }], done ? null : "live", "assistant", "saved", null);
  update("First thought. "); await setImmediate(); assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].segment, { index: 0, final: false });
  f.calls[0].emit("first PCM"); f.playing(true); const analyser = f.audio.current, resets = f.players[0].resets;
  update("First thought. Second thought. "); assert.equal(f.calls.length, 1);
  f.calls[0].resolve(); await setImmediate(); assert.equal(f.calls.length, 2); assert.equal(f.calls[1].text, "Second thought.");
  assert.equal(f.players[0].resets, resets); assert.equal(f.audio.current, analyser); assert.equal(f.controller.view.state, "playing");
  update("First thought. Second thought. The final phrase"); f.calls[1].resolve(); await setImmediate(); assert.equal(f.calls.length, 2);
  update("First thought. Second thought. The final phrase", true); await setImmediate(); assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].text, "The final phrase"); assert.deepEqual(f.calls[2].segment, { index: 2, final: true });
  assert.ok(f.calls.every(call => call.id === f.calls[0].id)); f.calls[2].resolve(); await setImmediate();
  update("First thought. Second thought. The final phrase", true); assert.equal(f.calls.length, 3); assert.equal(f.controller.view.state, "idle"); f.controller.dispose();
});

test("progressive Stop discards queued words and stale chunks; the 800-character budget spans calls", async () => {
  const f = fixture(); await f.controller.enable();
  const update = (content: string, done = false) => f.controller.observe([{ ...message(content), status: done ? "complete" : "streaming" }], done ? null : "live", "assistant", "saved", null);
  update("First thought. "); await setImmediate();
  update("First thought. " + "A clear thought. ".repeat(100)); f.calls[0].resolve(); await setImmediate();
  assert.equal(f.calls.length, 2); assert.ok(f.calls.map(call => call.text).join(" ").length <= 800); assert.ok(f.controller.view.notice?.includes("800"));
  f.controller.stop(); f.calls[1].emit("STALE"); await setImmediate(); assert.ok(f.calls[1].signal.aborted); assert.equal(f.players[0].appended.length, 0);
  update("First thought. " + "A clear thought. ".repeat(100), true); await setImmediate(); assert.equal(f.calls.length, 2); f.controller.dispose();
});


test("default browser controller permits production activation without starting a billable request", async () => {
  let players = 0, requests = 0;
  const controller = new CloudChatVoiceController({ current: null }, undefined, {
    createPlayer: () => { players++; return new Player() as unknown as DesignVoicePlayer; },
    stream: async () => { requests++; throw Error("No provider calls allowed"); },
  });
  assert.equal(controller.view.enabled, false);
  assert.equal(await controller.enable(), true); assert.equal(players, 1); assert.equal(requests, 0);
  controller.dispose();
});
