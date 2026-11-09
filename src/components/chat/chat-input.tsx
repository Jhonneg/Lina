"use client";

import { useLayoutEffect, type RefObject } from "react";
import styles from "./chat.module.css";

export function ChatInput({ draft, onDraftChange, pending, onSend, inputRef }: {
  draft: string;
  onDraftChange: (value: string) => void;
  pending: boolean;
  onSend: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "0px";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }, [draft, inputRef]);

  return (
    <footer className={styles.composerArea}>
      <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); onSend(); }}>
        <label className="sr-only" htmlFor="message">Message Lain</label>
        <textarea
          ref={inputRef}
          id="message"
          name="message"
          rows={1}
          enterKeyHint="send"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="What’s on your mind?"
          aria-describedby="composer-help preview-notice"
          onKeyDown={(event) => {
            // Safari can report the IME commit key as Enter with keyCode 229.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              event.preventDefault();
              if (!pending) onSend();
            }
          }}
        />
        <button type="submit" className={styles.send} aria-label="Send message" disabled={pending || !draft.trim()}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 18V6m-5 5 5-5 5 5" /></svg>
        </button>
      </form>
      <p id="composer-help" className={styles.keyboardHint}>Enter to send <span aria-hidden="true">·</span> Shift+Enter for a new line</p>
      <p id="preview-notice" className={styles.notice}>Local demo · scripted replies · clears on refresh</p>
    </footer>
  );
}
