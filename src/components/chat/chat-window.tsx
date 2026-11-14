"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { OrbPresence } from "@/components/orb/orb-presence";
import type { OrbState } from "@/components/orb/orb-state";
import { HistoryDrawer } from "./history-drawer";
import { ChatHeader } from "./chat-header";
import { ChatInput } from "./chat-input";
import { ChatMessage } from "./chat-message";
import { usePersistentChat } from "./use-persistent-chat";
import styles from "./chat.module.css";

const STATUS: Record<OrbState, string> = { idle: "Awaiting input", thinking: "Processing thought", talking: "Transmitting" };

export function ChatWindow() {
  const { state: { messages, phase, error, conversationId }, loading, blocked, bootError, retryAt,
    send: submit, stop, reset: clearConversation, retry, retryLabel, selectConversation, conversationDeleted } = usePersistentChat();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [showLatest, setShowLatest] = useState(false);
  const windowRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLOListElement>(null);
  const pinnedRef = useRef(true);
  const active = messages.length > 0;

  // Keep the composer in the visible area when mobile keyboards resize or pan
  // the visual viewport. Do not reflow the app while the user pinch-zooms.
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      const node = windowRef.current;
      if (!node) return;
      if (viewport && viewport.scale === 1) {
        node.style.setProperty("--chat-height", `${viewport.height}px`);
        node.style.setProperty("--chat-top", `${viewport.offsetTop}px`);
      } else {
        node.style.removeProperty("--chat-height");
        node.style.removeProperty("--chat-top");
      }
    };
    resize();
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    window.addEventListener("resize", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
      window.removeEventListener("resize", resize);
    };
  }, []);

  useLayoutEffect(() => {
    if (pinnedRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const region = scrollRef.current;
    const content = contentRef.current;
    if (!region || !content) return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) region.scrollTop = region.scrollHeight;
    });
    observer.observe(region);
    observer.observe(content);
    return () => observer.disconnect();
  }, [active]);

  function send() {
    if (!submit(draft.trim())) return;
    setDraft("");
    inputRef.current?.focus({ preventScroll: true });
  }

  function reset() {
    clearConversation();
    pinnedRef.current = true;
    setDraft("");
    setShowLatest(false);
    inputRef.current?.focus({ preventScroll: true });
  }

  return (
    <div ref={windowRef} className={styles.window} data-active={active}>
      <ChatHeader canReset={active || Boolean(conversationId) || Boolean(error)} onReset={reset} historyOpen={historyOpen} onToggleHistory={() => setHistoryOpen(open => !open)} />
      <main className={styles.conversation} aria-label="Chat with Lain">
        <div className={styles.presence}>
          <div className={styles.orbFrame} role="img" aria-label="Lain’s amber presence">
            <OrbPresence state={phase} />
          </div>
          <div className={styles.status} role="status" aria-live="polite" data-orb-state={phase}>
            <span aria-hidden="true" />{loading ?? STATUS[phase]}
          </div>
          <div className={styles.welcome} aria-hidden={active}>
            <h2>You are connected.</h2>
            <p>What shall we explore?</p>
          </div>
        </div>
        {active && (
          <div
            ref={scrollRef}
            className={styles.messages}
            role="log"
            aria-label="Conversation"
            aria-live="polite"
            aria-relevant="additions text"
            tabIndex={0}
            onScroll={(event) => {
              const node = event.currentTarget;
              const pinned = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
              if (pinned !== pinnedRef.current) {
                pinnedRef.current = pinned;
                setShowLatest(!pinned);
              }
            }}
          >
            <ol ref={contentRef} className={styles.messageList}>
              {messages.filter(message => message.role === "user" || message.content || message.status !== "pending").map((message) => <ChatMessage key={message.id} message={message} transmitting={phase === "talking"} />)}
            </ol>
          </div>
        )}
        {active && showLatest && (
          <button type="button" className={styles.latest} onClick={() => {
            pinnedRef.current = true;
            setShowLatest(false);
            if (scrollRef.current) {
              scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              scrollRef.current.focus({ preventScroll: true });
            }
          }}>Jump to latest <span aria-hidden="true">↓</span></button>
        )}
      </main>
      <ChatInput draft={draft} onDraftChange={setDraft} pending={phase !== "idle"} onSend={send} onStop={stop}
        error={error} onRetry={retry} retryLabel={retryLabel} retryDisabled={Boolean(loading) || retryAt > 0}
        disabled={Boolean(loading) || blocked || bootError} inputRef={inputRef} />
      <HistoryDrawer onDeleted={conversationDeleted} open={historyOpen} activeId={conversationId} onClose={() => setHistoryOpen(false)}
        onNewChat={reset} onSelect={id => {
          selectConversation(id); setDraft(""); setShowLatest(false); pinnedRef.current = true;
        }} />
    </div>
  );
}
