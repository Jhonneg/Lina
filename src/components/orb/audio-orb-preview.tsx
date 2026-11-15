"use client";

import { useEffect, useRef, useState } from "react";
import { AudioReactivity } from "../../lib/audio/reactivity";
import { createVoiceEngine, type VoiceEngine, type VoiceState } from "../../lib/voice";
import { OrbPresence } from "./orb-presence";
import { OrbDebug, type OrbDiagnostics } from "./orb-debug";
import styles from "./audio-orb-preview.module.css";

export function AudioOrbPreview() {
  const voice = useRef<VoiceEngine | null>(null), audio = useRef<AudioReactivity | null>(null);
  const diagnostics = useRef<OrbDiagnostics | null>(null), sensitivity = useRef(1.35), ticket = useRef(0);
  const [text, setText] = useState("You are connected. I am Lain. What shall we explore today?");
  const [state, setState] = useState<VoiceState>("idle"), [loading, setLoading] = useState("");
  const [error, setError] = useState<string | null>(null), [level, setLevel] = useState(1.35);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    let mounted = true;
    const engine = createVoiceEngine({ onStateChange: next => {
      if (!mounted) return;
      if (next === "playing" && engine.analyser) {
        audio.current?.dispose();
        audio.current = new AudioReactivity(engine.analyser, { sensitivity: sensitivity.current });
      } else { audio.current?.dispose(); audio.current = null; }
      setState(next);
    } });
    voice.current = engine;
    return () => {
      mounted = false;
      audio.current?.dispose(); audio.current = null; voice.current = null;
      void engine.dispose().catch(() => {});
    };
  }, []);

  async function speak() {
    const engine = voice.current;
    if (!engine || !text.trim()) return;
    const current = ++ticket.current;
    setError(null); setLoading("Preparing speech…");
    let last = "";
    try {
      await engine.speak(text, { onProgress: progress => {
        if (ticket.current !== current || voice.current !== engine) return;
        const message = progress.phase === "generating" ? "Generating Nicole speech…" :
          `Loading ${progress.file ?? "Kokoro"}${progress.percent === undefined ? "…" : ` · ${Math.floor(progress.percent)}%`}`;
        if (message !== last) { last = message; setLoading(message); }
      } });
    } catch (failure) {
      if (current !== ticket.current || voice.current !== engine) return;
      if (!(failure instanceof DOMException && failure.name === "AbortError")) setError(failure instanceof Error ? failure.message : "Speech could not start. Try again.");
    } finally { if (current === ticket.current && voice.current === engine) setLoading(""); }
  }
  function stop() {
    ticket.current++; voice.current?.stop(); audio.current?.dispose(); audio.current = null;
    setLoading(""); setError(null);
  }
  const phase = state === "playing" ? "talking" : state === "loading" || state === "generating" ? "thinking" : "idle";
  return <main className={styles.preview}>
    <h1>Audio-reactive orb · development preview</h1>
    <p>Nicole · Ethereal Companion Refined. Model files load only after Speak.</p>
    <div className={styles.orb} role="img" aria-label="Audio-reactive Lain orb">
      <OrbPresence state={phase} audioRef={audio} diagnosticsRef={diagnostics} />
    </div>
    <p role="status" data-voice-state={state}>{loading || (state === "playing" ? "Transmitting" : state === "error" ? "Speech unavailable" : "Awaiting input")}</p>
    <form onSubmit={event => { event.preventDefault(); void speak(); }}>
      <label htmlFor="speech-text">Sample sentence</label>
      <textarea id="speech-text" value={text} maxLength={4000} onChange={event => setText(event.target.value)} rows={3} />
      <label htmlFor="audio-sensitivity">Audio sensitivity <output htmlFor="audio-sensitivity">{level.toFixed(2)}×</output></label>
      <input id="audio-sensitivity" type="range" min={0} max={2.5} step={.05} value={level} onChange={event => {
        const value = Number(event.target.value); sensitivity.current = value; setLevel(value);
        audio.current?.configure({ sensitivity: value });
      }} />
      <div className={styles.controls}><button type="submit" disabled={!text.trim() || state === "loading" || state === "generating" || state === "playing"}>Speak</button>
        <button type="button" onClick={stop} disabled={state !== "playing" && state !== "loading" && state !== "generating"}>Stop</button></div>
    </form>
    {error && <p role="alert">{error}</p>}
    <OrbDebug diagnosticsRef={diagnostics} />
  </main>;
}
