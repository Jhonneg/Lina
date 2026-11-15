"use client";

import { useEffect, useRef, useState } from "react";
import { VoiceEngine } from "../../lib/voice/engine";
import { OrbPresence } from "../orb/orb-presence";

const TEXT = "You are connected. I am Lain. We can explore the quiet patterns of thought, one idea at a time.";
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function frameStats(samples: number[]) {
  const sorted = samples.slice().sort((a, b) => a - b);
  return { samples: sorted.length, medianMs: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)], over50ms: sorted.filter(value => value > 50).length };
}
/** Isolated benchmark; never used by the production voice factory. */
export function VoiceBenchmark() {
  const frames = useRef<number[]>([]), engine = useRef<VoiceEngine | null>(null), epoch = useRef(0);
  const [approved, setApproved] = useState(false), [busy, setBusy] = useState(false), [status, setStatus] = useState(""), [report, setReport] = useState<unknown>(null);
  useEffect(() => {
    let last = performance.now(), id = 0;
    const frame = (now: number) => { if (frames.current.length < 20000) frames.current.push(now - last); last = now; id = requestAnimationFrame(frame); };
    id = requestAnimationFrame(frame);
    return () => { epoch.current++; cancelAnimationFrame(id); void engine.current?.dispose(); };
  }, []);
  async function run(backend: "wasm" | "webgpu") {
    if (busy || process.env.NODE_ENV !== "development") return;
    const ticket = ++epoch.current, results: unknown[] = [];
    setBusy(true); setStatus("Preparing benchmark…");
    // Unlock immediately from this explicit click, before adapter/model awaits.
    const voice = new VoiceEngine({ provider: { generate: () => Promise.reject(), dispose() {} } });
    engine.current = voice;
    let worker: Worker | undefined, synthesis: VoiceEngine | undefined;
    try {
      await voice.unlock();
      let adapterInfo: unknown;
      if (backend === "webgpu") {
        if (!approved) throw Error("Approve the FP32 download first.");
        const gpu = (navigator as Navigator & { gpu?: { requestAdapter(options: { powerPreference: string }): Promise<{ info: { vendor: string; architecture: string; description: string; isFallbackAdapter?: boolean }; isFallbackAdapter?: boolean } | null> } }).gpu;
        const adapter = await gpu?.requestAdapter({ powerPreference: "high-performance" });
        const info = adapter?.info;
        if (!info || info.isFallbackAdapter || adapter?.isFallbackAdapter || /swiftshader|llvmpipe|software/i.test(`${info.vendor} ${info.architecture} ${info.description}`) || !/nvidia|intel|amd|apple|qualcomm|arm|samsung/i.test(info.vendor)) throw Error("No positively identified hardware WebGPU adapter; download skipped.");
        adapterInfo = info;
      }
      if (ticket !== epoch.current) return;
      worker = new Worker(new URL("../../lib/voice/benchmark.worker.ts", import.meta.url));
      let metrics: unknown;
      synthesis = new VoiceEngine({ provider: {
        generate: () => new Promise((resolve, reject) => {
          worker!.onmessage = ({ data }) => {
            if (ticket !== epoch.current) { reject(new DOMException("Cancelled", "AbortError")); return; }
            if (data.progress) { setStatus(`${backend}: ${data.progress.file} ${Math.floor(data.progress.percent)}%`); return; }
            if (data.error) { reject(Error(data.error)); return; }
            metrics = data.metrics; resolve(data.audio);
          };
          worker!.onerror = () => reject(Error("Benchmark worker failed.")); worker!.postMessage({ backend, text: TEXT });
        }), dispose: () => worker?.terminate(),
      } });
      // A context resumed by the initial gesture lets the existing engine exercise exact Refined playback.
      await synthesis.unlock();
      frames.current.length = 0; await wait(2500); const baseline = frameStats(frames.current.splice(0));
      for (let trial = 0; trial < 3 && ticket === epoch.current; trial++) {
        setStatus(`${backend}: trial ${trial + 1}/3`); frames.current.length = 0;
        const started = performance.now(), audio = await synthesis.prepare(TEXT);
        if (ticket !== epoch.current) return;
        await synthesis.play(audio); const sourceMs = performance.now() - started;
        const samples = new Float32Array(synthesis.analyser!.fftSize); let firstSignalMs: number | null = null;
        while (synthesis.state === "playing" && ticket === epoch.current) {
          synthesis.analyser?.getFloatTimeDomainData(samples);
          if (firstSignalMs === null && samples.some(value => Math.abs(value) > .0001)) firstSignalMs = performance.now() - started;
          await wait(20);
        }
        results.push({ backend, trial, metrics, sourceMs, firstSignalMs, frames: frameStats(frames.current.splice(0)) });
      }
      if (ticket === epoch.current) { setReport({ text: TEXT, adapterInfo, baseline, results }); setStatus("Complete. RTF uses raw generated audio duration. First signal is an analyser proxy, not physical speaker latency."); }
    } catch (error) { if (ticket === epoch.current) setStatus(error instanceof Error ? error.message : "Benchmark failed."); }
    finally { await voice.dispose(); await synthesis?.dispose(); worker?.terminate(); if (ticket === epoch.current) { engine.current = null; setBusy(false); } }
  }
  return <main style={{ padding: 24 }}>
    <h1>Nicole · isolated voice benchmark</h1>
    <p>Exact Refined processing. One cold and two warm trials per backend. Production remains Q8/WASM.</p>
    <div style={{ width: 360, height: 360, maxWidth: "100%" }}><OrbPresence state={busy ? "talking" : "idle"} /></div>
    <label><input type="checkbox" checked={approved} disabled={busy} onChange={event => setApproved(event.target.checked)} /> Approve the approximately 326 MB FP32 download plus runtime assets, only with a verified hardware adapter.</label>
    <p><button disabled={busy} onClick={() => void run("wasm")}>Benchmark Q8/WASM (~93 MB)</button>{" "}<button disabled={busy || !approved} onClick={() => void run("webgpu")}>Benchmark FP32/WebGPU</button></p>
    <p role="status">{status}</p><pre style={{ overflowX: "auto" }}>{report ? JSON.stringify(report, null, 2) : "No model loads before a benchmark click."}</pre>
  </main>;
}
