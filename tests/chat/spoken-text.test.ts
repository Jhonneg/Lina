import assert from "node:assert/strict";
import { test } from "node:test";
import { spokenResponse } from "../../src/components/chat/spoken-text";

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

