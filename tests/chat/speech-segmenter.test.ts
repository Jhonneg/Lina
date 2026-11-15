import assert from "node:assert/strict";
import { test } from "node:test";
import { SpeechSegmenter, speechBoundary } from "../../src/components/chat/speech-segmenter";
function drain(segmenter: SpeechSegmenter) { const result: string[] = []; for (let i = 0; i < 1000; i++) { const text = segmenter.next(); if (!text) return result; result.push(text); } throw Error("Unbounded segmenter"); }

test("sentence buffering waits for boundaries, preserves abbreviations/decimals, and flushes the final phrase", () => {
  const s = new SpeechSegmenter(); s.update("Dr. "); assert.equal(s.next(), undefined);
  s.update("Dr. Smith measured 3."); assert.equal(s.next(), undefined);
  s.update("Dr. Smith measured 3.14. "); assert.equal(s.next(), "Dr. Smith measured 3.14.");
  s.update("Dr. Smith measured 3.14. Another thought"); assert.equal(s.next(), undefined);
  s.update("Dr. Smith measured 3.14. Another thought", true); assert.equal(s.next(), "Another thought");
  assert.deepEqual(drain(s), []); assert.ok(s.finished);
  assert.equal(speechBoundary("An e.g. example. More words", false, false), "An e.g. example. ".length);
});

test("partial Markdown, links, inline code, emphasis and fenced blocks never leak formatting", () => {
  const s = new SpeechSegmenter(); s.update("Hello. **A half"); assert.equal(s.next(), "Hello."); assert.equal(s.next(), undefined);
  s.update("Hello. **A half sentence.** "); assert.equal(s.next(), "A half sentence.");
  s.update("Hello. **A half sentence.** [A label."); assert.equal(s.next(), undefined);
  s.update("Hello. **A half sentence.** [A label.](https://example.com) "); assert.equal(s.next(), "A label.");
  s.update("Hello. **A half sentence.** [A label.](https://example.com)\n\n```js\nNEVER_READ();"); assert.deepEqual(drain(s), []);
  s.update("Hello. **A half sentence.** [A label.](https://example.com)\n\n```js\nNEVER_READ();\n```\n\nUse `value` now. ", true);
  assert.deepEqual(drain(s), ["Use value now."]);
});

test("byte-sized stream updates produce each eligible sentence exactly once, including a rewritten persisted snapshot", () => {
  const source = "You are connected. I am Lain. A final thought", s = new SpeechSegmenter(), result: string[] = [];
  for (let i = 1; i <= source.length; i++) { s.update(source.slice(0, i)); result.push(...drain(s)); }
  s.update(source, true); result.push(...drain(s)); assert.deepEqual(result, ["You are connected.", "I am Lain.", "A final thought"]);
  s.update(source, true); assert.deepEqual(drain(s), []);
  const changed = new SpeechSegmenter(); changed.update("Original thought. "); assert.equal(changed.next(), "Original thought.");
  changed.update("A rewritten thought. ", true); assert.deepEqual(drain(changed), []);
});

test("phrases never split words or decimal numbers, and work remains bounded at 4,000 characters", () => {
  const s = new SpeechSegmenter(); s.update("A clear thought. ".repeat(1000), true); const chunks = drain(s);
  assert.ok(s.truncated); assert.ok(chunks.reduce((total, chunk) => total + chunk.length, 0) <= 4000);
  assert.ok(chunks.every(chunk => chunk.length <= 600));
  const word = new SpeechSegmenter(); word.update("x".repeat(800), true); assert.deepEqual(drain(word), []); assert.ok(word.truncated);
  const incomplete = new SpeechSegmenter(); incomplete.update("Safe text **unfinished", true); assert.deepEqual(drain(incomplete), ["Safe text unfinished"]);
});


test("literal punctuation cannot suppress the rest of a response, and final incomplete emphasis is retained", () => {
  for (const source of ["Use foo_bar. Then continue. ", "Two times 2*3 is six. Keep speaking. ", "2 < 3 is true. More words. ", "A | B is a choice. Continue. "]) {
    const s = new SpeechSegmenter(); s.update(source, true);
    assert.equal(drain(s).join(" "), source.trim()); assert.equal(s.truncated, false);
  }
  const s = new SpeechSegmenter(); s.update("First thought. **Unfinished words");
  assert.equal(s.next(), "First thought."); assert.equal(s.next(), undefined);
  s.update("First thought. **Unfinished words", true);
  assert.deepEqual(drain(s), ["Unfinished words"]); assert.equal(s.rewritten, false);
  const link = new SpeechSegmenter(); link.update("See [the reference](https://unfinished", true);
  assert.deepEqual(drain(link), ["See the reference"]);
});

test("rewritten spoken prefixes are reported, and the final budget retains whole eligible words", () => {
  const s = new SpeechSegmenter(); s.update("Already spoken. "); assert.equal(s.next(), "Already spoken.");
  s.update("Changed prefix. More words.", true); assert.deepEqual(drain(s), []); assert.equal(s.rewritten, true); assert.equal(s.truncated, true);
  const budget = new SpeechSegmenter(); budget.update("word ".repeat(850), true);
  const output = drain(budget).join(" "); assert.ok(output.length <= 4000 && output.length >= 3990);
  assert.ok(budget.truncated && budget.finished);
});
