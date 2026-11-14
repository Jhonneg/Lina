import { NewChat } from "./new-chat";
import styles from "./chat.module.css";
import historyStyles from "./history-drawer.module.css";

export function ChatHeader({ canReset, onReset, historyOpen, onToggleHistory }: { canReset: boolean; onReset: () => void; historyOpen: boolean; onToggleHistory: () => void }) {
  return (
    <header className={styles.header}>
      <div className={styles.identity}>
        <button type="button" className={historyStyles.toggle} aria-label="Open conversation history" aria-expanded={historyOpen}
          aria-controls="conversation-history" onClick={event => { event.currentTarget.focus({ preventScroll: true }); onToggleHistory(); }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h12M4 18h16" /></svg>
        </button>
        <h1>LAIN <span>2.0</span></h1>
        <span className={styles.preview}>Conversation</span>
      </div>
      <NewChat disabled={!canReset} onReset={onReset} />
    </header>
  );
}
