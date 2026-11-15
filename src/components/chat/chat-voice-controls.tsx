"use client";

import { useEffect, useRef } from "react";
import type { VoiceView } from "./voice-types";
import styles from "./chat-voice.module.css";

export function ChatVoiceControls({ view, onToggle, onEnable, onStop, onVolume }: {
  view: VoiceView; onToggle: () => void; onEnable: () => void;
  onStop: () => void; onVolume: (volume: number) => void;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const busy = ["activating", "loading", "generating", "playing", "buffering"].includes(view.state);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !details.current?.contains(event.target)) details.current?.removeAttribute("open"); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
  useEffect(() => { if (view.error) details.current?.setAttribute("open", ""); }, [view.error]);
  return <div className={styles.controls}>
    <details ref={details} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); details.current?.removeAttribute("open"); details.current?.querySelector("summary")?.focus(); } }}>
      <summary className={styles.icon} aria-label="Voice controls" title={view.enabled ? "Voice enabled" : "Voice disabled"} data-voice-enabled={view.enabled}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m11 5-6 4H2v6h3l6 4V5Z" />{view.enabled ? <path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /> : <path d="m16 9 6 6m0-6-6 6" />}</svg>
      </summary>
      <section className={styles.panel} aria-label="Voice settings">
        <button type="button" aria-pressed={view.enabled} onClick={onToggle}>{view.enabled ? "Disable voice" : "Enable voice"}</button>
        {view.enabled && !view.permitted && <button type="button" onClick={() => onEnable()}>Enable playback</button>}
        <label htmlFor="voice-volume">Volume <output>{Math.round(view.volume * 100)}%</output></label>
        <input id="voice-volume" type="range" min={0} max={1} step={.05} value={view.volume} onChange={event => onVolume(Number(event.target.value))} />
        <button type="button" onClick={onStop} disabled={!busy}>Stop voice</button>
        <p role="status" data-chat-voice-state={view.state}>{view.progress || (view.state === "error" ? "Voice unavailable" : view.state === "playing" ? "Reading aloud" : busy ? "Preparing voice…" : view.enabled ? "Voice ready" : "Voice off")}</p>
        {view.error && <p role="alert">{view.error} Text chat is still available.</p>}
        {view.notice && <p role="status">{view.notice}</p>}
        {!view.enabled && view.preferredEnabled && <p>Previously enabled. Enable voice again to allow playback this visit.</p>}
        <p>AI-generated cloud speech · Shimmer · Lain robo preset. Enabling voice sends completed replies to OpenAI for paid narration. Up to 800 spoken characters; code blocks are skipped. Available in local development only.</p>
      </section>
    </details>

  </div>;
}
