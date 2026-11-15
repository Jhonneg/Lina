"use client";

import { useEffect, useRef, useState } from "react";
import { AudioReactivity } from "../../lib/audio/reactivity";
import { DesignVoicePlayer } from "../../lib/cloud-voice/design-player";
import { DesignAudioCache, type DryTake } from "../../lib/cloud-voice/design-cache";
import { DELIVERY_DEFAULT, DESIGN_RANGES, DESIGN_REFINED, DESIGN_ORIGINAL, loadDesignPresets, parseDesignPreset, saveDesignPreset, type DesignEffects, type DesignParameter, type DesignPreset } from "../../lib/cloud-voice/design-presets";
import { streamCloudVoice, type CloudVoiceResult } from "../../lib/cloud-voice/stream";
import { OrbPresence } from "../orb/orb-presence";
import styles from "./cloud-voice-lab.module.css";

export function CloudVoiceLab() {
  const [text, setText] = useState("You are connected. I am Lain. What shall we explore today?");
  const [voice, setVoice] = useState("marin"), [effects, setEffects] = useState<DesignEffects>({ ...DESIGN_REFINED }), [volume, setVolume] = useState(.8);
  const [delivery, setDelivery] = useState(DELIVERY_DEFAULT), [selection, setSelection] = useState("refined"), [presetName, setPresetName] = useState("Custom voice");
  const [presets, setPresets] = useState<DesignPreset[]>([]), [cachedSource, setCachedSource] = useState<{ text: string; voice: string; delivery: string } | null>(null);
  const [replayAudio, setReplayAudio] = useState<number | null>(null);
  const cache = useRef(new DesignAudioCache());
  const [busy, setBusy] = useState(false), [phase, setPhase] = useState<"idle" | "thinking" | "talking">("idle");
  const [status, setStatus] = useState("Ready for manual evaluation."), [error, setError] = useState<string | null>(null);
  const [firstAudio, setFirstAudio] = useState<number | null>(null), [result, setResult] = useState<CloudVoiceResult | null>(null);
  const player = useRef<DesignVoicePlayer | null>(null), operation = useRef<AbortController | null>(null), ticket = useRef(0), frame = useRef(0);
  const audio = useRef<AudioReactivity | null>(null);
  useEffect(() => {
    const takes = cache;
    const timer = setTimeout(() => { try { setPresets(loadDesignPresets(window.localStorage)); } catch { setStatus("Saved presets could not be loaded. Built-in presets remain available."); } }, 0);
    const resource = player, request = operation, analysis = audio, lifetime = ticket, meter = frame;
    const cleanup = () => { clearTimeout(timer); takes.current.clear(); lifetime.current++; request.current?.abort(); void resource.current?.stop(); resource.current = null; analysis.current?.dispose(); analysis.current = null; cancelAnimationFrame(meter.current); };
    window.addEventListener("pagehide", cleanup);
    return () => { window.removeEventListener("pagehide", cleanup); cleanup(); };
  }, []);
  function stop() {
    ticket.current++; operation.current?.abort(); operation.current = null;
    void player.current?.stop(); player.current = null; audio.current?.dispose(); audio.current = null; cancelAnimationFrame(frame.current);
    setBusy(false); setPhase("idle"); setStatus("Stopped. Generated audio may still incur charges.");
  }
  async function speak(generate = true) {
    const cached = cache.current.take;
    if (operation.current || (generate ? !text.trim() : !cached) || process.env.NODE_ENV !== "development") return;
    const source = generate ? { text, voice, delivery } : cached!;
    const captured = cache.current.capture();
    let savedTake: DryTake | null = null, firstSignal: number | null = null;
    const current = ++ticket.current, controller = new AbortController(), started = performance.now();
    operation.current = controller; setBusy(true); setPhase("thinking"); setError(null);
    if (generate) { setResult(null); setFirstAudio(null); } else { setResult(cached!.result); setFirstAudio(cached!.firstAudioMs ?? null); setReplayAudio(null); }
    setStatus(generate ? "Connecting and generating…" : "Replaying cached dry audio · no API request…");
    let measured = false, receiving = true;
    const samples = new Float32Array(2048);
    let engine: DesignVoicePlayer | undefined;
    const meter = () => {
      if (current !== ticket.current || measured || controller.signal.aborted) return;
      const analyser = engine?.analyser;
      if (analyser) { analyser.getFloatTimeDomainData(samples); if (samples.some(value => Math.abs(value) > .0001)) { measured = true; firstSignal = performance.now() - started; if (generate) { setFirstAudio(firstSignal); if (savedTake) savedTake.firstAudioMs = firstSignal; } else setReplayAudio(firstSignal); return; } }
      frame.current = requestAnimationFrame(meter);
    };
    const abort = () => { void engine?.stop(); };
    controller.signal.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(() => controller.abort(), 90_000);
    try {
      engine = new DesignVoicePlayer({ ...effects }, playing => {
        if (current !== ticket.current) return;
        audio.current?.dispose(); audio.current = null;
        if (playing && engine?.analyser) audio.current = new AudioReactivity(engine.analyser, { sensitivity: 1.35 });
        setPhase(playing ? "talking" : receiving ? "thinking" : "idle");
        if (playing) setStatus("Playing AI-generated speech…"); else if (receiving) setStatus("Waiting for audio…");
        if (playing && !measured) { cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(meter); }
      });
      player.current = engine; engine.setVolume(volume);
      // Resume synchronously from this explicit Speak action; no microphone or model assets.
      await engine.unlock(); controller.signal.throwIfAborted();
      let completed: CloudVoiceResult;
      if (generate) {
        const session = await fetch("/api/session", { method: "POST", credentials: "same-origin", signal: controller.signal });
        if (!session.ok) throw Error("Could not initialize the anonymous session. Please try again.");
        completed = await streamCloudVoice(source.text, source.voice, controller.signal, pcm => {
          if (current === ticket.current && !controller.signal.aborted) { captured.append(pcm); engine?.append(pcm); }
        }, undefined, undefined, source.delivery);
        if (current !== ticket.current || controller.signal.aborted) return;
        savedTake = captured.commit({ ...source, result: completed, firstAudioMs: firstSignal });
        setCachedSource({ text: source.text, voice: source.voice, delivery: source.delivery });
      } else {
        for (const pcm of cached!.chunks) { controller.signal.throwIfAborted(); engine.append(pcm); }
        completed = cached!.result;
      }
      if (current !== ticket.current) return;
      receiving = false; setResult(completed); await engine.finish(); controller.signal.throwIfAborted();
      if (current === ticket.current) setStatus(generate ? "Evaluation complete. Dry audio cached for free comparisons." : "Cached replay complete · no API request.");
    } catch (failure) {
      receiving = false;
      if (current === ticket.current) {
        setError(controller.signal.aborted ? "Evaluation cancelled or time limit reached." : failure instanceof Error ? failure.message : "Speech is unavailable."); setStatus("Ready to try again.");
      }
    } finally {
      clearTimeout(deadline); controller.signal.removeEventListener("abort", abort);
      await engine?.stop();
      if (current === ticket.current) {
        cancelAnimationFrame(frame.current); audio.current?.dispose(); audio.current = null; player.current = null; operation.current = null;
        setBusy(false); setPhase("idle");
      }
    }
  }
  function applyPreset(value: string) {
    setSelection(value); setError(null);
    if (value === "original") setEffects({ ...DESIGN_ORIGINAL });
    else if (value === "refined") setEffects({ ...DESIGN_REFINED });
    else if (value.startsWith("saved:")) {
      const preset = presets.find(item => item.name === value.slice(6));
      if (preset) { setEffects({ ...preset.effects }); setVoice(preset.voice); setDelivery(preset.delivery); setPresetName(preset.name); }
    }
  }
  function currentPreset() { return parseDesignPreset({ version: 1, name: presetName, voice, delivery, effects }); }
  function savePreset() {
    try { const preset = currentPreset(); setPresets(saveDesignPreset(window.localStorage, preset)); setSelection(`saved:${preset.name}`); setStatus("Preset saved in this browser. No audio was generated."); setError(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Preset could not be saved."); }
  }
  function exportPreset() {
    try {
      const preset = currentPreset(), url = URL.createObjectURL(new Blob([JSON.stringify(preset, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "lain-voice-preset.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0); setError(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Preset could not be exported."); }
  }
  return <main className={styles.lab}>
    <h1>OpenAI Voice Lab</h1>
    <p>Development evaluation · gpt-realtime-2.1-mini. This voice is AI-generated.</p>
    <p>Generate & speak makes one billable cloud request. Replaying cached audio is free. No microphone is used and no Kokoro model is downloaded.</p>
    <div className={styles.orb}><OrbPresence state={phase} audioRef={audio} /></div>
    <form onSubmit={event => { event.preventDefault(); void speak(true); }}>
      <label htmlFor="cloud-voice">Voice</label>
      <select id="cloud-voice" disabled={busy} value={voice} onChange={event => setVoice(event.target.value)}>{["Marin", "Shimmer", "Coral", "Cedar"].map(name => <option key={name} value={name.toLowerCase()}>{name}</option>)}</select>
      <label htmlFor="cloud-text">Sample text ({text.length}/800)</label>
      <textarea id="cloud-text" value={text} disabled={busy} maxLength={800} rows={4} onChange={event => setText(event.target.value)} />
      <label htmlFor="cloud-delivery">Vocal delivery instructions ({delivery.length}/1,200)</label>
      <textarea id="cloud-delivery" value={delivery} disabled={busy} maxLength={1200} rows={3} onChange={event => setDelivery(event.target.value)} />
      <p>Delivery and narration are separate. Changing delivery, text or voice requires Generate; DSP comparisons use the cached take.</p>
      <label htmlFor="cloud-effects">Effects preset</label>
      <select id="cloud-effects" value={selection} onChange={event => applyPreset(event.target.value)}>
        <option value="original">Original · dry</option><option value="refined">Refined · original approved preset</option><option value="custom">Custom effects</option>
        {presets.map(preset => <option key={preset.name} value={`saved:${preset.name}`}>{preset.name} · saved</option>)}
      </select>
      <p>Effects apply on the next playback. Stop, adjust, then replay the same dry audio without regenerating.</p>
      <fieldset className={styles.effects}><legend>Voice design</legend>
        {(Object.keys(DESIGN_RANGES) as DesignParameter[]).map(key => {
          const range = DESIGN_RANGES[key];
          return <div key={key}><label htmlFor={`effect-${key}`}>{range.label} · {effects[key]} {range.unit}</label>
            <input id={`effect-${key}`} type="range" min={range.min} max={range.max} step={range.step} value={effects[key]} onChange={event => { setSelection("custom"); setEffects(previous => ({ ...previous, mode: "custom", [key]: Number(event.target.value) })); }} /></div>;
        })}
      </fieldset>
      <label htmlFor="preset-name">Preset name</label><input id="preset-name" type="text" value={presetName} maxLength={60} onChange={event => setPresetName(event.target.value)} />
      <div className={styles.controls}><button type="button" onClick={savePreset}>Save preset</button><button type="button" onClick={exportPreset}>Export preset JSON</button></div>
      <label htmlFor="cloud-volume">Volume · {Math.round(volume * 100)}%</label>
      <input id="cloud-volume" type="range" min={0} max={1} step={.01} value={volume} onChange={event => { const value = Number(event.target.value); setVolume(value); player.current?.setVolume(value); }} />
      <div className={styles.controls}><button type="submit" disabled={busy || !text.trim()}>Generate & speak · billable</button><button type="button" disabled={busy || !cachedSource} onClick={() => void speak(false)}>Replay cached audio · free</button><button type="button" disabled={!busy} onClick={stop}>Stop</button></div>
    </form>
    <p role="status" data-cloud-phase={phase}>{status}</p>{error && <p role="alert">{error}</p>}
    {cachedSource && <details><summary>Cached dry take · {cachedSource.voice} · memory only</summary><p>{cachedSource.text}</p><p>Delivery: {cachedSource.delivery || "Neutral narration"}</p></details>}
    <dl><dt>Time to first audio · generation</dt><dd>{firstAudio === null ? "—" : `${(firstAudio / 1000).toFixed(2)} s (analyser signal)`}</dd>
      <dt>Replay time to audio</dt><dd>{replayAudio === null ? "—" : `${(replayAudio / 1000).toFixed(2)} s (local replay)`}</dd>
      <dt>Total generation time</dt><dd>{result ? `${(result.generationMs / 1000).toFixed(2)} s` : "—"}</dd>
      <dt>Estimated generation cost</dt><dd>{result?.estimatedCostUsd == null ? "Unavailable until usage is returned" : `$${result.estimatedCostUsd.toFixed(6)} USD`}</dd></dl>
    <p>Replays make no API request. Only the latest successful dry take is cached until this page closes; saved/exported presets contain no audio or narration text. Estimate uses standard token rates; final billing may differ. Narration is requested verbatim; compare the output during evaluation.</p>
    {result?.transcript && <details><summary>Generated transcript</summary><p>{result.transcript}</p></details>}
  </main>;
}
