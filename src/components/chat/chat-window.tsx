"use client";

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { OrbPresence } from "@/components/orb/orb-presence";
import type { OrbState } from "@/components/orb/orb-state";
import { ChatHeader } from "./chat-header";
import { ChatInput } from "./chat-input";
import { ChatMessage } from "./chat-message";
import type { Message } from "./chat-types";
import { chatReducer, conversationContext, INITIAL_CHAT, MAX_MESSAGE_CHARS } from "./chat-state";
import { ChatStreamError, streamChat, type ContextMessage } from "./chat-stream";
import styles from "./chat.module.css";

const STATUS: Record<OrbState, string> = { idle: "Ready", thinking: "Thinking", talking: "Responding" };

export function ChatWindow() {
  const [{ messages, phase, error, retryContext }, dispatch] = useReducer(chatReducer, INITIAL_CHAT);
  const [draft, setDraft] = useState("");
  const [showLatest, setShowLatest] = useState(false);
  const windowRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLOListElement>(null);
  const pinnedRef = useRef(true);
  const requestRef = useRef<{ id: string; controller: AbortController } | null>(null);
  const active = messages.length > 0;

  useEffect(() => () => {
    requestRef.current?.controller.abort();
    requestRef.current = null;
  }, []);

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

  async function generate(context: ContextMessage[], user?: Message) {
    // Ref guards same-tick submissions before React commits the pending state.
    if (requestRef.current) return;
    const controller = new AbortController();
    const id = crypto.randomUUID();
    requestRef.current = { id, controller };
    dispatch({ type: "start", requestId: id, context, user });
    try {
      await streamChat(context, controller.signal, (text) => {
        dispatch({ type: "delta", requestId: id, text });
      });
      if (!controller.signal.aborted) dispatch({ type: "finish", requestId: id, outcome: "complete" });
    } catch (failure) {
      if (!controller.signal.aborted) dispatch({ type: "finish", requestId: id, outcome: "interrupted",
        error: failure instanceof ChatStreamError ? failure.message : "Unable to reach Lain. Please try again." });
    } finally {
      if (requestRef.current?.id === id) requestRef.current = null;
    }
  }

  function send() {
    const text = draft.trim();
    if (!text || text.length > MAX_MESSAGE_CHARS || requestRef.current) return;
    const user: Message = { id: crypto.randomUUID(), role: "user", content: text };
    void generate(conversationContext([...messages, user]), user);
    setDraft("");
    inputRef.current?.focus({ preventScroll: true });
  }

  function stop() {
    const request = requestRef.current;
    if (!request) return;
    request.controller.abort();
    requestRef.current = null;
    dispatch({ type: "finish", requestId: request.id, outcome: "interrupted" });
  }

  function reset() {
    requestRef.current?.controller.abort();
    requestRef.current = null;
    dispatch({ type: "reset" });
    pinnedRef.current = true;
    setDraft("");
    setShowLatest(false);
    inputRef.current?.focus({ preventScroll: true });
  }

  return (
    <div ref={windowRef} className={styles.window} data-active={active}>
      <ChatHeader canReset={active} onReset={reset} />
      <main className={styles.conversation} aria-label="Chat with Lain">
        <div className={styles.presence}>
          <div className={styles.orbFrame} role="img" aria-label="Lain’s amber presence">
            <OrbPresence state={phase} />
          </div>
          <div className={styles.status} role="status" aria-live="polite" data-orb-state={phase}>
            <span aria-hidden="true" />{STATUS[phase]}
          </div>
          <div className={styles.welcome} aria-hidden={active}>
            <h2>Room for a thought.</h2>
            <p>No rush. Start wherever you are.</p>
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
              {messages.map((message) => <ChatMessage key={message.id} message={message} />)}
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
        error={error} onRetry={() => { void generate(retryContext); }} inputRef={inputRef} />
    </div>
  );
}
