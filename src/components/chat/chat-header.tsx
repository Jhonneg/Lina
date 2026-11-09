import { NewChat } from "./new-chat";
import styles from "./chat.module.css";

export function ChatHeader({ canReset, onReset }: { canReset: boolean; onReset: () => void }) {
  return (
    <header className={styles.header}>
      <div className={styles.identity}>
        <h1>LAIN <span>2.0</span></h1>
        <span className={styles.preview}>Local preview</span>
      </div>
      <NewChat disabled={!canReset} onReset={onReset} />
    </header>
  );
}
