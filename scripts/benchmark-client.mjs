// Focused CDP benchmark. All API calls are mocked in the browser before hydration.
// Requires an existing Chromium binary; downloads no browser/model/dependencies.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
const label = process.argv[2] ?? 'baseline', origin = process.env.BENCH_ORIGIN ?? 'http://127.0.0.1:3160';
const executable = process.env.CHROMIUM_PATH;
if (!executable) throw Error('Set CHROMIUM_PATH to an existing Chromium/headless-shell executable.');
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw Error('Only a local benchmark origin is allowed.');
const profile = mkdtempSync('/tmp/lain-6c-browser-');
const browser = spawn(executable, ['--no-sandbox', '--headless', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan', '--disable-vulkan-surface', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=9245', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let ws;
try {
  let endpoint;
  for (let i = 0; i < 100; i++) { try { endpoint = await (await fetch('http://127.0.0.1:9245/json/version')).json(); break; } catch { await delay(100); } }
  if (!endpoint) throw Error('Chromium CDP unavailable');
  ws = new WebSocket(endpoint.webSocketDebuggerUrl); await new Promise(resolve => { ws.onopen = resolve; });
  let next = 0; const pending = new Map(), listeners = new Set();
  ws.onmessage = ({ data }) => { const m = JSON.parse(data); if (m.id) { const waiter = pending.get(m.id); pending.delete(m.id); if (m.error) waiter.reject(Error(JSON.stringify(m.error))); else waiter.resolve(m.result); } else for (const listener of listeners) listener(m); };
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  const system = await call('SystemInfo.getInfo'), version = await call('Browser.getVersion');
  const trials = [];
  for (let trial = 0; trial < 3; trial++) {
    const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
    const evaluate = async expression => { const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const uuid = n => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
    const history = Array.from({ length: 40 }, (_, i) => ({ id: uuid(i), conversationId, role: i % 2 ? 'assistant' : 'user', content: i % 2 ? `## Saved thought ${i}\n\nA calm paragraph with **emphasis**, a [reference](https://example.com) and a short list.\n\n- First idea\n- Second idea` : `A saved question ${i}.`, status: 'completed', createdAt: new Date(1700000000000 + i * 1000).toISOString() }));
    const errors = []; let apiRequests = 0;
    const listener = async m => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
      if (m.method !== 'Fetch.requestPaused') return;
      const { requestId, request } = m.params; apiRequests++;
      const url = new URL(request.url);
      const body = url.pathname === '/api/session' ? { ok: true, session: { id: uuid(90), expiresAt: '2030-01-01T00:00:00Z' } } : url.pathname.startsWith('/api/conversations/') ? { ok: true, conversation: { id: conversationId, title: 'Benchmark fixture', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }, messages: history, pagination: { limit: 50, offset: 0, nextOffset: null } } : { ok: true, conversations: [], pagination: { limit: 20, offset: 0, nextOffset: null } };
      await call('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') }, sessionId);
    };
    listeners.add(listener);
    await call('Performance.enable', {}, sessionId); await call('Runtime.enable', {}, sessionId); await call('Page.enable', {}, sessionId);
    await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false }, sessionId);
    await call('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] }, sessionId);
    await call('Network.enable', {}, sessionId);
    await call('Network.setBlockedURLs', { urls: ['*api.openai.com*', '*huggingface.co*', '*cdn.jsdelivr.net*'] }, sessionId);
    await call('Page.addScriptToEvaluateOnNewDocument', { source: readFileSync(new URL('./benchmark-client-init.js', import.meta.url), 'utf8') }, sessionId);
    await call('Page.navigate', { url: `${origin}/?conversation=${conversationId}` }, sessionId);
    for (let i = 0; i < 120; i++) { if (await evaluate('document.querySelectorAll("article[data-message-id]").length === 40 && !!document.querySelector("canvas") && !document.querySelector("textarea")?.disabled')) break; if (i === 119) throw Error('Page fixture did not become ready'); await delay(500); }
    await delay(1500);
    const idle = await evaluate('bench.sample(2500)');
    const gl = await evaluate('(()=>{const c=document.querySelector("canvas"),g=c.getContext("webgl2"),e=g?.getExtension("WEBGL_debug_renderer_info");return {width:c.width,height:c.height,cssWidth:c.clientWidth,cssHeight:c.clientHeight,dpr:devicePixelRatio,renderer:e?g.getParameter(e.UNMASKED_RENDERER_WEBGL):null}})()');
    await call('HeapProfiler.collectGarbage', {}, sessionId);
    const heapBefore = await call('Runtime.getHeapUsage', {}, sessionId);
    await evaluate('document.querySelector("summary[aria-label=\\"Voice controls\\"]").click(); [...document.querySelectorAll("button")].find(b=>b.textContent==="Enable voice").click()');
    await delay(100);
    const rounds = [];
    for (let round = 0; round < 3; round++) {
      await evaluate('bench.clear(); document.querySelector("textarea").focus()');
      await call('Input.insertText', { text: 'Performance fixture question.' }, sessionId);
      const metricsBefore = Object.fromEntries((await call('Performance.getMetrics', {}, sessionId)).metrics.map(m => [m.name, m.value]));
      const start = Date.now(); await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId); await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
      for (let i = 0; i < 160; i++) { if (await evaluate(`document.querySelectorAll('article[data-message-id]').length === ${42 + round * 2} && [...document.querySelectorAll('article[data-message-id]')].at(-1)?.dataset.responseStatus === 'complete' && bench.activeSources === 0 && bench.voiceCalls >= ${round + 1} && !document.querySelector('[data-orb-state="thinking"]') && !document.querySelector('[data-orb-state="talking"]')`)) break; if (i === 159) throw Error('Mock round failed: ' + await evaluate('document.body.innerText.slice(-1000)')); await delay(100); }
      const metricsAfter = Object.fromEntries((await call('Performance.getMetrics', {}, sessionId)).metrics.map(m => [m.name, m.value]));
      const cpuMs = Object.fromEntries(['ScriptDuration', 'TaskDuration', 'LayoutDuration', 'RecalcStyleDuration'].map(name => [name, (metricsAfter[name] - metricsBefore[name]) * 1000]));
      rounds.push({ wallMs: Date.now() - start, cpuMs, ...await evaluate('bench.snapshot()') });
    }
    await call('HeapProfiler.collectGarbage', {}, sessionId);
    const heapAfter = await call('Runtime.getHeapUsage', {}, sessionId);
    await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="Disable voice").click()');
    await delay(100);
    const cleanup = await evaluate('({activeSources:bench.activeSources,contexts:bench.contexts,canvases:document.querySelectorAll("canvas").length,liveBuffers:bench.liveBuffers})');
    await evaluate('Object.defineProperty(document,"hidden",{configurable:true,get:()=>true}); document.dispatchEvent(new Event("visibilitychange"))');
    await delay(150); const hidden = await evaluate('bench.sample(700)');
    await evaluate('Object.defineProperty(document,"hidden",{configurable:true,get:()=>false}); document.dispatchEvent(new Event("visibilitychange"))');
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
    await delay(150); const reduced = await evaluate('bench.sample(700)');
    const resources = await evaluate('performance.getEntriesByType("resource").filter(r=>r.name.includes(".js")).map(r=>({path:new URL(r.name).pathname,decoded:r.decodedBodySize,transferred:r.transferSize}))');
    trials.push({ idle, gl, rounds, heapBefore, heapAfter, cleanup, hidden, reduced, resources, apiRequests, errors });
    console.log(JSON.stringify({ label, trial: trial + 1, idleFps: idle.fps, rounds: rounds.map(r => ({ wallMs: r.wallMs, chatMessageWork: r.work.ChatMessage, commits: r.commits })), cleanup, errors }));
    listeners.delete(listener); await call('Target.closeTarget', { targetId });
  }
  const report = { label, at: new Date().toISOString(), environment: { cpu: cpus()[0]?.model, cpuCount: cpus().length, chromium: version.product, gpu: system.gpu.devices, features: system.gpu.featureStatus, headless: true, viewport: [1440, 900], deviceScaleFactor: 2, development: true, mockedApis: true }, trials };
  writeFileSync(`docs/performance-6c-${label}.json`, JSON.stringify(report, null, 2) + '\n');
} finally { ws?.close(); browser.kill('SIGTERM'); }
