"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { appendHistory, fetchHistoryPage, groupHistory, renameConversation, deleteConversation, type HistoryConversation } from "./chat-history";
import { initializeSession } from "./chat-persistence";
import { ChatStreamError } from "./chat-stream";
import { HistoryEntry } from "./history-entry";
import { NewChat } from "./new-chat";
import styles from "./history-drawer.module.css";

export function HistoryDrawer({ open, activeId, onClose, onSelect, onNewChat, onDeleted }: {
  open: boolean; activeId: string | null; onClose: () => void; onSelect: (id: string) => void; onNewChat: () => void; onDeleted: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const request = useRef<AbortController | null>(null);
  const visible = useRef(open);
  const deleted = useRef(new Set<string>());
  useEffect(() => { visible.current = open; }, [open]);
  const lastPage = useRef({ offset: 0, reset: true });
  const [items, setItems] = useState<HistoryConversation[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; code: string } | null>(null);

  const load = useCallback(async (offset: number, reset: boolean, refreshSession = false, keepItems = false) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    lastPage.current = { offset, reset };
    setLoading(true); setError(null);
    if (reset) { if (!keepItems) setItems([]); setNextOffset(null); }
    try {
      const result = await fetchHistoryPage(offset, controller.signal, fetch, () => initializeSession(refreshSession));
      if (controller.signal.aborted || request.current !== controller) return;
      const incoming = result.items.filter(item => !deleted.current.has(item.id));
      setItems(previous => reset ? incoming : appendHistory(previous, incoming));
      setNextOffset(result.nextOffset);
    } catch (failure) {
      if (controller.signal.aborted || request.current !== controller) return;
      setError({ message: failure instanceof ChatStreamError ? failure.message : "Unable to load conversation history. Please try again.",
        code: failure instanceof ChatStreamError ? failure.code : "NETWORK_ERROR" });
    } finally { if (!controller.signal.aborted && request.current === controller) setLoading(false); }
  }, []);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    let frame: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    if (open) {
      if (!node.open) {
        opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        node.showModal();
      }
      frame = requestAnimationFrame(() => { node.dataset.open = "true"; closeButton.current?.focus({ preventScroll: true }); });
    } else if (node.open) {
      node.dataset.open = "false";
      const close = () => { node.close(); if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); };
      timer = setTimeout(close, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220);
    }
    return () => { if (frame !== undefined) cancelAnimationFrame(frame); if (timer !== undefined) clearTimeout(timer); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => { void load(0, true); }, 0);
    return () => { clearTimeout(timer); request.current?.abort(); };
  }, [open, activeId, load]);
  useEffect(() => () => { request.current?.abort(); }, []);

  async function rename(id: string, title: string) {
    const item = await renameConversation(id, title, AbortSignal.timeout(10000));
    setItems(previous => previous.map(entry => entry.id === id ? item : entry));
    if (visible.current) void load(0, true, false, true);
  }
  async function remove(id: string) {
    await deleteConversation(id, AbortSignal.timeout(10000));
    deleted.current.add(id); request.current?.abort();
    onDeleted(id);
    setItems(previous => previous.filter(item => item.id !== id));
    if (visible.current) { closeButton.current?.focus({ preventScroll: true }); void load(0, true, false, true); }
  }

  return (
    <dialog ref={dialog} id="conversation-history" className={styles.drawer} data-open="false" aria-modal="true" aria-labelledby="history-title"
      onKeyDown={event => {
        if (event.key !== "Tab") return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      onCancel={event => { event.preventDefault(); onClose(); }} onClose={onClose}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}>
      <div className={styles.panel}>
        <header className={styles.header}>
          <h2 id="history-title">Conversations</h2>
          <button ref={closeButton} type="button" className={styles.iconButton} aria-label="Close history" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
          </button>
        </header>
        <div className={styles.newChat}><NewChat onReset={() => { onNewChat(); onClose(); }} /></div>
        <div className={styles.list} aria-busy={loading}>
          {groupHistory(items).map(group => <section key={group.label} aria-label={group.label}>
            <h3>{group.label}</h3>
            <ul>{group.items.map(item => <HistoryEntry key={item.id} item={item} active={activeId === item.id}
              onSelect={() => { onSelect(item.id); onClose(); }} onRename={rename} onDelete={remove} />)}</ul>
          </section>)}
          {loading && <p className={styles.message} role="status">Loading conversations…</p>}
          {!loading && !error && items.length === 0 && <p className={styles.message}>No conversations yet.</p>}
          {error && <div className={styles.message}>
            <p role="alert">{error.message}</p>
            <button type="button" className={styles.action} onClick={() => { void load(lastPage.current.offset, lastPage.current.reset, error.code === "SESSION_REQUIRED"); }}>Try again</button>
          </div>}
          {nextOffset !== null && !error && <button type="button" className={styles.action} disabled={loading} onClick={() => { void load(nextOffset, false); }}>Load more</button>}
        </div>
      </div>
    </dialog>
  );
}
