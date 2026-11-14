"use client";

import { useEffect, useRef, useState } from "react";
import { historyTitle, type HistoryConversation } from "./chat-history";
import { ChatStreamError } from "./chat-stream";
import styles from "./history-drawer.module.css";

export function HistoryEntry({ item, active, onSelect, onRename, onDelete }: {
  item: HistoryConversation; active: boolean; onSelect: () => void;
  onRename: (id: string, title: string) => Promise<void>; onDelete: (id: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"view" | "menu" | "rename" | "delete">("view");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLLIElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), cancelDelete = useRef<HTMLButtonElement>(null);
  const lastItem = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (mode === "menu") {
      const buttons = menu.current?.querySelectorAll<HTMLButtonElement>("button");
      (lastItem.current ? buttons?.[buttons.length - 1] : buttons?.[0])?.focus();
    }
    if (mode === "rename") { input.current?.focus(); input.current?.select(); }
    if (mode === "delete") cancelDelete.current?.focus();
    if (mode !== "menu") return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setMode("view"); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [mode]);
  function close() {
    if (busy) return;
    setMode("view"); setError(null);
    if (trigger.current?.closest("dialog")?.open) trigger.current.focus();
  }
  async function save(remove = false) {
    if (busy) return;
    if (!remove && (!title.trim() || title.length > 200)) { setError("Provide a title of at most 200 characters."); return; }
    setBusy(true); setError(null);
    try {
      if (remove) await onDelete(item.id); else await onRename(item.id, title.trim());
      if (!mounted.current) return;
      setMode("view");
      if (trigger.current?.closest("dialog")?.open) trigger.current.focus();
    } catch (failure) {
      if (mounted.current) setError(failure instanceof ChatStreamError ? failure.message : "Unable to save this change. Please try again.");
    } finally { if (mounted.current) setBusy(false); }
  }
  return <li ref={root} onKeyDown={event => {
    if (event.key === "Escape" && mode !== "view" && !busy) { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <div className={styles.entryRow}>
      <button type="button" className={styles.entry} data-conversation-id={item.id} aria-current={active ? "page" : undefined} onClick={onSelect} disabled={busy}>
        <span>{historyTitle(item)}</span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time>
      </button>
      <button ref={trigger} type="button" className={styles.more} aria-label={`Actions for ${historyTitle(item)}`} aria-haspopup="menu"
        aria-expanded={mode === "menu"} aria-controls={`history-menu-${item.id}`} disabled={busy}
        onClick={() => { lastItem.current = false; setError(null); setMode(current => current === "menu" ? "view" : "menu"); }}
        onKeyDown={event => { if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); lastItem.current = event.key === "ArrowUp"; setMode("menu"); } }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
      </button>
      {mode === "menu" && <div ref={menu} id={`history-menu-${item.id}`} role="menu" aria-label="Conversation actions" className={styles.menu}
        onKeyDown={event => {
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }
          if (event.key === "Tab") { event.preventDefault(); close(); }
        }}>
        <button type="button" role="menuitem" onClick={() => { setTitle(item.title ?? ""); setMode("rename"); }}>Rename</button>
        <button type="button" role="menuitem" className={styles.destructive} onClick={() => setMode("delete")}>Delete</button>
      </div>}
    </div>
    {mode === "rename" && <form className={styles.editor} aria-label="Rename conversation" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label htmlFor={`title-${item.id}`}>Conversation title</label>
      <input ref={input} id={`title-${item.id}`} value={title} maxLength={200} disabled={busy} onChange={event => setTitle(event.target.value)} />
      <div className={styles.editorActions}><button type="submit" className={styles.action} disabled={busy || !title.trim()}>Save</button><button type="button" className={styles.action} disabled={busy} onClick={close}>Cancel</button></div>
    </form>}
    {mode === "delete" && <div className={styles.editor} role="group" aria-label="Confirm permanent deletion">
      <p>Delete this conversation permanently? Its messages cannot be recovered.</p>
      <div className={styles.editorActions}><button type="button" className={`${styles.action} ${styles.destructive}`} disabled={busy} onClick={() => { void save(true); }}>Delete conversation</button><button ref={cancelDelete} type="button" className={styles.action} disabled={busy} onClick={close}>Cancel</button></div>
    </div>}
    {error && <p className={styles.entryError} role="alert">{error}</p>}
  </li>;
}
