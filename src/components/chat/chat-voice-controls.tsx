"use client";

import { useEffect, useRef } from "react";
import type { VoiceView } from "./chat-voice-controller";
import styles from "./chat-voice.module.css";

export function ChatVoiceControls({ view, consentOpen, onToggle, onEnable, onConsentCancel, onStop, onVolume }: {
  view: VoiceView; consentOpen: boolean; onToggle: () => void; onEnable: (consent?: boolean) => void;
  onConsentCancel: () => void; onStop: () => void; onVolume: (volume: number) => void;
}) {
  const details = useRef<HTMLDetailsElement>(null), dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const busy = ["activating", "loading", "generating", "playing", "buffering"].includes(view.state);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (consentOpen && !node.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      node.showModal(); cancel.current?.focus();
    } else if (!consentOpen && node.open) {
      node.close(); opener.current?.focus({ preventScroll: true });
    }
  }, [consentOpen]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (dialog.current?.open) return; if (event.target instanceof Node && !details.current?.contains(event.target)) details.current?.removeAttribute("open"); };
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
        <p>Nicole speaks English. Code blocks are skipped.</p>
      </section>
    </details>
    <dialog ref={dialog} className={styles.consent} aria-labelledby="voice-consent-title" onCancel={event => { event.preventDefault(); onConsentCancel(); }}>
      <h2 id="voice-consent-title">Enable Lain’s voice?</h2>
      <p>The first spoken response downloads approximately 93 MB of model data plus runtime assets. Speech is generated on your device using Nicole’s English voice.</p>
      <p>Your browser may cache these files for later visits. While enabled, new replies are read progressively when playback is permitted. You can also read previous replies individually.</p>
      <div><button type="button" onClick={() => onEnable(true)}>Allow download and enable voice</button><button ref={cancel} type="button" onClick={onConsentCancel}>Cancel</button></div>
    </dialog>
  </div>;
}
