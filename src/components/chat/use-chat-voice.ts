"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AudioReactivity } from "../../lib/audio/reactivity";
import { CloudChatVoiceController, INITIAL_CLOUD_VOICE } from "./cloud-chat-voice-controller";
import type { ChatState } from "./chat-state";
import type { Message } from "./chat-types";

export function useChatVoice({ messages, requestId, assistantId, conversationId, loading, streamObserverRef }: {
  messages: readonly Message[]; requestId: string | null; assistantId: string | null; conversationId: string | null; loading: string | null; streamObserverRef?: RefObject<((state: ChatState) => void) | null>;
}) {
  const controller = useRef<CloudChatVoiceController | null>(null), audio = useRef<AudioReactivity | null>(null);
  const pending = useRef<Message | null>(null), dialogTicket = useRef(0);
  const [view, setView] = useState(INITIAL_CLOUD_VOICE);
  useEffect(() => {
    let storage;
    try { storage = window.localStorage; } catch { /* Optional preferences. */ }
    const current = new CloudChatVoiceController(audio, storage);
    controller.current = current;
    const observe = (state: ChatState) => current.observe(state.messages, state.requestId, state.assistantId, state.conversationId, null);
    if (streamObserverRef) streamObserverRef.current = observe;
    const unsubscribe = current.subscribe(() => setView(current.view));
    // Preference hydration happens after mount and never creates an engine.
    const timer = setTimeout(() => setView(current.view), 0);
    const cancel = () => { dialogTicket.current++; pending.current = null; current.stop(); };
    window.addEventListener("popstate", cancel); window.addEventListener("pagehide", cancel);
    return () => { if (streamObserverRef?.current === observe) streamObserverRef.current = null; clearTimeout(timer); unsubscribe(); current.dispose(); if (controller.current === current) controller.current = null;
      window.removeEventListener("popstate", cancel); window.removeEventListener("pagehide", cancel); };
  }, [streamObserverRef]);
  useEffect(() => { controller.current?.observe(messages, requestId, assistantId, conversationId, loading); }, [messages, requestId, assistantId, conversationId, loading]);

  function stop() { dialogTicket.current++; pending.current = null; controller.current?.stop(); }
  const enable = useCallback(() => {
    const current = controller.current;
    if (!current) return;
    const ticket = ++dialogTicket.current, message = pending.current; pending.current = null;

    // enable() calls AudioContext.resume synchronously inside this click handler.
    void current.enable().then(activated => {
      if (activated && ticket === dialogTicket.current && controller.current === current && message) void current.play(message);
    });
  }, []);
  function toggle() {
    if (controller.current?.view.enabled) { stop(); controller.current.disable(); }
    else enable();
  }
  const read = useCallback((message: Message) => {
    const current = controller.current;
    if (!current) return;
    if (current.view.messageId === message.id) { stop(); return; }
    if (!current.view.enabled || !current.view.permitted) { pending.current = message; enable(); return; }
    void current.play(message);
  }, [enable]);
  return { view, audio, enable, toggle, read, stop,
    setVolume: (value: number) => controller.current?.setVolume(value) };
}
