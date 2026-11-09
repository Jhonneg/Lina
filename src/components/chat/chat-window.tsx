"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { OrbPresence } from "@/components/orb/orb-presence";
import type { OrbState } from "@/components/orb/orb-state";
import { ChatHeader } from "./chat-header";
import { ChatInput } from "./chat-input";
import { ChatMessage } from "./chat-message";
import type { Message } from "./chat-types";
import styles from "./chat.module.css";

const REPLIES = [
  "Let’s take it one thought at a time. What would you like to explore a little further?",
  "We can leave some room around that. What feels most important to you right now?",
  "There’s no rush. Start wherever you like, and we’ll make space for the next thought.",
];
const STATUS: Record<OrbState, string> = { idle: "Ready", thinking: "Thinking", talking: "Responding" };

export function ChatWindow() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [phase, setPhase] = useState<OrbState>("idle");
  const [showLatest, setShowLatest] = useState(false);
  const windowRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLOListElement>(null);
  const pinnedRef = useRef(true);
  const pendingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const active = messages.length > 0;

  useEffect(() => () => {
    generationRef.current++;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
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

  function send() {
    const text = draft.trim();
    // Ref guards same-tick submissions as well as the disabled submit button.
    if (!text || pendingRef.current) return;
    pendingRef.current = true;
    pinnedRef.current = true;
    setShowLatest(false);
    const generation = generationRef.current;
    const reply = REPLIES[messages.filter((message) => message.role === "user").length % REPLIES.length];
    const userMessage: Message = { id: crypto.randomUUID(), role: "user", content: text };
    setMessages((previous) => [...previous, userMessage]);
    setDraft("");
    inputRef.current?.focus();
    setPhase("thinking");
    timerRef.current = setTimeout(() => {
      if (generation !== generationRef.current) return;
      const assistantMessage: Message = { id: crypto.randomUUID(), role: "assistant", content: reply };
      setMessages((previous) => [...previous, assistantMessage]);
      setPhase("talking");
      timerRef.current = setTimeout(() => {
        if (generation !== generationRef.current) return;
        timerRef.current = null;
        pendingRef.current = false;
        setPhase("idle");
      }, 1600);
    }, 900);
  }

  function reset() {
    generationRef.current++;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingRef.current = false;
    pinnedRef.current = true;
    setMessages([]);
    setDraft("");
    setPhase("idle");
    setShowLatest(false);
    inputRef.current?.focus();
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
            aria-relevant="additions"
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
      <ChatInput draft={draft} onDraftChange={setDraft} pending={phase !== "idle"} onSend={send} inputRef={inputRef} />
    </div>
  );
}
