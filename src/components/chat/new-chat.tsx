import styles from "./chat.module.css";

export function NewChat({ disabled, onReset }: { disabled: boolean; onReset: () => void }) {
  return (
    <button type="button" className={styles.newChat} disabled={disabled} onClick={onReset}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
      New chat
    </button>
  );
}
