/* Browser-only instrumentation injected by benchmark-client.mjs before hydration. */
(() => {
  const active = new Set(), buffers = new Set();
  const b = window.bench = { work: {}, commits: 0, draws: 0, triangles: 0, lines: 0, frameMs: [], longTasks: [], voiceCalls: 0, audioBuffers: 0, peakSources: 0, openedContexts: 0, closedContexts: 0,
    get activeSources() { return active.size; }, get contexts() { return this.openedContexts - this.closedContexts; }, get liveBuffers() { return buffers.size; },
    clear() { this.work = {}; this.commits = 0; this.draws = 0; this.triangles = 0; this.lines = 0; this.frameMs = []; this.longTasks = []; this.peakSources = active.size; this.at = performance.now(); },
    snapshot() { const times = [...this.frameMs].sort((a, b) => a - b); return { work: { ...this.work }, commits: this.commits, draws: this.draws, triangles: this.triangles, lines: this.lines, frames: times.length, fps: times.length * 1000 / (performance.now() - this.at), medianFrameMs: times[Math.floor(times.length / 2)] ?? null, p95FrameMs: times[Math.floor(times.length * .95)] ?? null, longTaskMs: this.longTasks.reduce((a, n) => a + n, 0), longTaskCount: this.longTasks.length, activeSources: active.size, peakSources: this.peakSources, audioBuffers: this.audioBuffers, contexts: this.contexts, liveBuffers: buffers.size }; },
    async sample(ms) { this.clear(); await new Promise(resolve => setTimeout(resolve, ms)); return this.snapshot(); },
  };
  b.clear();
  let prior = performance.now();
  const frame = time => { b.frameMs.push(time - prior); prior = time; requestAnimationFrame(frame); }; requestAnimationFrame(frame);
  new PerformanceObserver(list => { for (const entry of list.getEntries()) b.longTasks.push(entry.duration); }).observe({ type: 'longtask' });
  let renderer = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), inject(value) { const id = ++renderer; this.renderers.set(id, value); return id; }, onCommitFiberRoot(_id, root) {
    b.commits++;
    function visit(fiber) { if (!fiber) return; const name = fiber.type?.name ?? fiber.type?.type?.name; if ((fiber.flags & 1) && ['ChatMessage', 'MarkdownResponse', 'ChatWindow'].includes(name)) b.work[name] = (b.work[name] ?? 0) + 1; // A bailed-out parent can retain children with old PerformedWork flags.
      // Skip that shared child tree rather than counting stale descendant work.
      if (!fiber.alternate || fiber.child !== fiber.alternate.child) visit(fiber.child);
      visit(fiber.sibling); }
    visit(root.current);
  }, onCommitFiberUnmount() {} };
  for (const Context of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!Context) continue;
    for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      const original = Context.prototype[name]; if (!original) continue;
      Context.prototype[name] = function (...args) { b.draws++; const count = name.includes('Elements') ? args[1] : args[2], instances = name.endsWith('Instanced') ? args.at(-1) : 1; if (args[0] === this.TRIANGLES) b.triangles += count / 3 * instances; if (args[0] === this.LINES) b.lines += count / 2 * instances; return original.apply(this, args); };
    }
    const create = Context.prototype.createBuffer, remove = Context.prototype.deleteBuffer;
    Context.prototype.createBuffer = function () { const buffer = create.call(this); buffers.add(buffer); return buffer; };
    Context.prototype.deleteBuffer = function (buffer) { buffers.delete(buffer); return remove.call(this, buffer); };
  }
  const NativeAudio = window.AudioContext;
  if (NativeAudio) window.AudioContext = new Proxy(NativeAudio, { construct(Target, args) { const context = new Target(...args); b.openedContexts++; const close = context.close.bind(context); context.close = () => { b.closedContexts++; return close(); }; return context; } });
  const createSource = BaseAudioContext.prototype.createBufferSource, createAudioBuffer = BaseAudioContext.prototype.createBuffer;
  BaseAudioContext.prototype.createBuffer = function (...args) { b.audioBuffers++; return createAudioBuffer.apply(this, args); };
  BaseAudioContext.prototype.createBufferSource = function () { const source = createSource.call(this), start = source.start.bind(source), stop = source.stop.bind(source); source.start = (...args) => { active.add(source); b.peakSources = Math.max(b.peakSources, active.size); return start(...args); }; source.stop = (...args) => { active.delete(source); return stop(...args); }; source.addEventListener('ended', () => active.delete(source)); return source; };
  const nativeFetch = window.fetch.bind(window), encode = new TextEncoder();
  const text = '## A quiet idea\n\nA measured response can contain **meaningful emphasis** and calm, practical explanations. Let us examine the evidence before reaching a conclusion.\n\n' + ('A second paragraph connects the observation to a useful next step. ').repeat(16) + '\n```javascript\nconst answer = 42;\n```\n';
  const pcm = new Uint8Array(4800); const view = new DataView(pcm.buffer);
  for (let i = 0; i < 2400; i++) view.setInt16(i * 2, Math.round(Math.sin(i * 2 * Math.PI * 220 / 24000) * 4000), true);
  const base64 = btoa(String.fromCharCode(...pcm));
  window.fetch = async (input, options = {}) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
    if (path !== '/api/chat/stream' && path !== '/api/voice') return nativeFetch(input, options);
    const value = JSON.parse(options.body), signal = options.signal;
    let cancelled = false, timer;
    const event = (name, payload) => encode.encode(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
    const frames = path === '/api/chat/stream' ? [event('metadata', { requestId: value.requestId, conversationId: value.conversationId, userMessageId: crypto.randomUUID(), assistantMessageId: crypto.randomUUID(), replayed: false }), ...text.match(/.{1,20}|\n/gu).map(part => event('delta', { text: part })), event('done', { finishReason: 'completed', saved: true })] : [...Array.from({ length: 12 }, () => event('audio', { pcm: base64, sampleRate: 24000 })), event('done', { generationMs: 600, estimatedCostUsd: null, transcript: value.text })];
    if (path === '/api/voice') b.voiceCalls++;
    const body = new ReadableStream({ start(controller) {
      let i = 0;
      const abort = () => { cancelled = true; clearTimeout(timer); try { controller.close(); } catch { /* Already closed. */ } };
      signal?.addEventListener('abort', abort, { once: true });
      const emit = () => { if (cancelled) return; if (i === frames.length) { signal?.removeEventListener('abort', abort); controller.close(); return; } controller.enqueue(frames[i++]); timer = setTimeout(emit, path === '/api/voice' ? 40 : 35); }; emit();
    }, cancel() { cancelled = true; clearTimeout(timer); } });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  };
})();
