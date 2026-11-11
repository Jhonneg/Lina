"use client";

import { useLayoutEffect, type RefObject } from "react";
import styles from "./chat.module.css";
import { MAX_MESSAGE_CHARS } from "./chat-state";

export function ChatInput({ draft, onDraftChange, pending, onSend, onStop, error, onRetry, inputRef }: {
  draft: string;
  onDraftChange: (value: string) => void;
  pending: boolean;
  onSend: () => void;
  onStop: () => void;
  error: string | null;
  onRetry: () => void;
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
      {error && <div className={styles.error}>
        <p role="alert">{error}</p>
        <button type="button" className={styles.newChat} onClick={onRetry} disabled={pending}>Retry response</button>
      </div>}
      <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); onSend(); }}>
        <label className="sr-only" htmlFor="message">Message Lain</label>
        <textarea
          ref={inputRef}
          id="message"
          name="message"
          rows={1}
          maxLength={MAX_MESSAGE_CHARS}
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
        {pending ? <button type="button" className={styles.send} aria-label="Stop generating" onClick={onStop}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
        </button> : <button type="submit" className={styles.send} aria-label="Send message" disabled={!draft.trim() || draft.trim().length > MAX_MESSAGE_CHARS}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 18V6m-5 5 5-5 5 5" /></svg>
        </button>}
      </form>
      <p id="composer-help" className={styles.keyboardHint}>Enter to send <span aria-hidden="true">·</span> Shift+Enter for a new line</p>
      <p id="preview-notice" className={styles.notice}>Conversation clears on refresh</p>
    </footer>
  );
}
