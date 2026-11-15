import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownResponse } from "../../src/components/chat/markdown-response";
import { ChatMessage } from "../../src/components/chat/chat-message";
import { highlightCode } from "../../src/components/chat/highlighted-code";

function markdown(content: string, streaming = false) {
  return renderToStaticMarkup(<MarkdownResponse content={content} streaming={streaming} />);
}

test("assistant Markdown renders headings, paragraphs, lists, quotes, links and inline code", () => {
  const html = markdown('# A thought\n\nA **strong** and *quiet* paragraph with `code`.\n\n- One\n- Two\n\n1. First\n2. Second\n\n> A quote\n\n[Reference](https://example.com)');
  for (const tag of ["h1", "p", "strong", "em", "code", "ul", "ol", "blockquote"]) assert.ok(html.includes(`<${tag}>`));
  assert.ok(html.includes('<li>One</li>'));
  assert.ok(html.includes('href="https://example.com" target="_blank" rel="noopener noreferrer"'));
});

test("GFM supports scrollable tables, strikethrough and task lists", () => {
  const html = markdown('| Key | Value |\n| --- | --- |\n| A | B |\n\n~~Before~~\n\n- [x] Done\n- [ ] Later');
  assert.ok(html.includes('role="region" aria-label="Response table"'));
  assert.ok(html.includes('<table>') && html.includes('<th>Key</th>') && html.includes('<td>B</td>'));
  assert.ok(html.includes('<del>Before</del>'));
  assert.ok(html.includes('type="checkbox"') && html.includes('disabled=""'));
});

test("code blocks retain labels, exact escaped code text and semantic copy controls", () => {
  const html = markdown('```javascript\nconst example = "<script>alert(1)</script>";\n```', true);
  assert.ok(html.includes('data-code-language="javascript"'));
  assert.ok(html.includes('aria-label="Copy code"'));
  assert.ok(html.includes('tabindex="0" aria-label="javascript code"'));
  assert.ok(html.includes('const example = &quot;&lt;script&gt;alert(1)&lt;/script&gt;&quot;;\n'));
  assert.ok(!html.includes('<script>'));
  const plain = markdown('```\nPlain code\n```', true);
  assert.ok(plain.includes('data-code-language="text"') && plain.includes('Plain code\n'));
});

test("incomplete streamed fences, links and emphasis remain readable without highlighting", () => {
  const content = 'A **partial thought\n\n```python\ndef hello():\n    print("<hello>"';
  const html = markdown(content, true);
  assert.ok(html.includes('A **partial thought'));
  assert.ok(html.includes('data-code-language="python"'));
  assert.ok(html.includes('def hello():\n    print(&quot;&lt;hello&gt;&quot;\n'));
  assert.ok(!html.includes('hljs-'));
  assert.ok(markdown('[unfinished link](https://exam', true).includes('unfinished link'));
});

test("raw HTML and unsafe links cannot introduce executable or remote image content", () => {
  const html = markdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29) [data](data:text/html,evil) [vb](vbscript:evil)\n\n![Image description](https://tracker.example/pixel)');
  for (const unsafe of ['<script', '<img', 'onerror=', 'href="javascript:', 'href="data:', 'href="vbscript:', 'src="https://tracker']) assert.ok(!html.includes(unsafe), unsafe);
  assert.ok(html.includes('bad') && html.includes('data') && html.includes('Image description'));
  assert.ok(markdown('[Mail](mailto:hello@example.com)').includes('href="mailto:hello@example.com"'));
});

test("explicit common grammars highlight into escaped React spans; unknown languages fall back to text", () => {
  for (const [language, code] of [
    ["javascript", 'const x = "value";'], ["ts", 'const x: string = "value";'], ["python", 'def hello():\n  return "world"'],
    ["json", '{"key": true}'], ["bash", 'echo "$HOME"'], ["sql", 'SELECT * FROM messages;'],
    ["html", '<div class="test">Text</div>'], ["css", 'body { color: red; }'], ["c", 'int main() { return 0; }'],
  ]) {
    const html = renderToStaticMarkup(<code>{highlightCode(code, language)}</code>);
    assert.ok(html.includes('class="hljs-'), language);
  }
  const source = '<script>window.bad = true;</script>';
  assert.equal(highlightCode(source, 'unknown-language'), source);
  const html = markdown('```unknown-language\n'+source+'\n```', true);
  assert.ok(html.includes('data-code-language="unknown-language"'));
  assert.ok(html.includes('&lt;script&gt;') && !html.includes('<script>'));
  const long = 'x'.repeat(16001);
  assert.equal(highlightCode(long, 'js'), long);
});

test("user text stays literal; only complete assistant responses have whole-response copy", () => {
  const content = '# Heading\n\n**Literal** <img src=x onerror=alert(1)>';
  const user = renderToStaticMarkup(<ChatMessage message={{ id: 'user', role: 'user', content, status: 'complete' }} />);
  assert.ok(user.includes('# Heading') && user.includes('**Literal**') && user.includes('&lt;img'));
  assert.ok(!user.includes('<h1>') && !user.includes('Copy response'));
  const assistant = renderToStaticMarkup(<ChatMessage message={{ id: 'assistant', role: 'assistant', content, status: 'complete' }} />);
  assert.ok(assistant.includes('<h1>Heading</h1>') && assistant.includes('aria-label="Copy response"'));
  assert.ok(!assistant.includes('data-streaming-cursor'));
  assert.ok(!markdown('', true).includes('data-streaming-cursor'));
  const stopped = renderToStaticMarkup(<ChatMessage transmitting={false} message={{ id: 'stopped', role: 'assistant', content: 'Partial response', status: 'streaming' }} />);
  assert.ok(stopped.includes('Partial response') && !stopped.includes('data-streaming-cursor'));
  for (const status of ['streaming', 'interrupted', 'failed', 'pending'] as const) {
    const html = renderToStaticMarkup(<ChatMessage message={{ id: 'partial', role: 'assistant', content: '```js\nconst x = 1;', status }} />);
    assert.ok(html.includes('const x = 1;'));
    assert.ok(!html.includes('Copy response'));
    assert.equal(html.includes('data-streaming-cursor'), status === 'streaming');
    if (status !== 'streaming') assert.ok(html.includes(status === 'pending' ? 'Response not yet saved' : `Response ${status}`));
  }
});


test("composer has an accessible name and only references existing help text", async () => {
  const { ChatInput } = await import("../../src/components/chat/chat-input");
  const html = renderToStaticMarkup(<ChatInput draft="" onDraftChange={() => {}} pending={false} onSend={() => {}} onStop={() => {}}
    error={null} onRetry={() => {}} retryLabel="Retry" retryDisabled={false} disabled={false} inputRef={{ current: null }} />);
  assert.ok(html.includes('for="message"') && html.includes('Message Lain'));
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
  for (const match of html.matchAll(/aria-describedby="([^"]+)"/g)) {
    for (const id of match[1].split(" ")) assert.ok(ids.has(id), `Missing description: ${id}`);
  }
});
