import assert from "node:assert/strict";
import { test } from "node:test";
import { CloudSpeechBuffer } from "../../src/components/chat/cloud-speech-buffer";
import { streamCloudVoice } from "../../src/lib/cloud-voice/stream";

function take(buffer: CloudSpeechBuffer) { const chunks: string[] = []; let next; while ((next = buffer.next())) chunks.push(next.text); return chunks; }
test("natural streaming boundaries retain abbreviations, decimals, final words and Markdown filtering", () => {
  const buffer = new CloudSpeechBuffer(true), source = "Dr. Smith measured 3.14. Another **clear** thought.\n\n```js\nNEVER_READ\n```\n\nThe last phrase", output: string[] = [];
  for (let i = 1; i <= source.length; i++) { buffer.update(source.slice(0, i), false); output.push(...take(buffer)); }
  buffer.update(source, true); output.push(...take(buffer));
  assert.equal(output.join(" "), "Dr. Smith measured 3.14. Another clear thought. The last phrase"); assert.ok(output.length <= 3); assert.ok(buffer.finished);
  buffer.update(source, true); assert.deepEqual(take(buffer), []);
});

test("third batch waits for final text while retaining every eligible word, with a cumulative cap", () => {
  const buffer = new CloudSpeechBuffer(true);
  buffer.update("One thought. ", false); assert.deepEqual(take(buffer), ["One thought."]);
  buffer.update("One thought. Two thoughts. ", false); assert.deepEqual(take(buffer), ["Two thoughts."]);
  buffer.update("One thought. Two thoughts. Three thoughts. Four thoughts. ", false); assert.deepEqual(take(buffer), []);
  buffer.update("One thought. Two thoughts. Three thoughts. Four thoughts. End", true); assert.deepEqual(take(buffer), ["Three thoughts. Four thoughts. End"]);
  const long = new CloudSpeechBuffer(true); long.update("An eligible thought. ".repeat(200), false);
  const text = take(long).join(" "); assert.ok(text.length <= 800 && text.length > 770); assert.ok(long.truncated && long.finished);
});

test("manual completed playback stays one call; rewritten prefixes are flagged without repeats", () => {
  const completed = new CloudSpeechBuffer(false); completed.update("One thought. Two thoughts.", true); assert.deepEqual(take(completed), ["One thought. Two thoughts."]);
  const changed = new CloudSpeechBuffer(true); changed.update("Original thought. ", false); take(changed);
  changed.update("Rewritten thought.", true); assert.ok(changed.rewritten); assert.deepEqual(take(changed), []);
});

test("progressive request metadata is structured while ordinary chat speech remains compatible", async () => {
  const bodies: unknown[] = [];
  const fetcher: typeof fetch = async (_url, options) => {
    bodies.push(JSON.parse(String(options?.body)));
    return new Response('event: done\ndata: {"generationMs":1,"estimatedCostUsd":null,"transcript":"ok"}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  };
  await streamCloudVoice("First.", "shimmer", new AbortController().signal, () => {}, fetcher, "id", undefined, { index: 0, final: false });
  assert.deepEqual(bodies, [{ text: "First.", requestId: "id", segment: { index: 0, final: false } }]);
});
