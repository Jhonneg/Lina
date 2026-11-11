import type { Message } from "./chat-types";
import styles from "./chat.module.css";

export function ChatMessage({ message }: { message: Message }) {
  const user = message.role === "user";
  return (
    <li className={user ? styles.userMessage : styles.assistantMessage}>
      <article aria-label={user ? "You" : "Lain"} data-message-id={message.id} data-response-status={message.status}>
        <p className={styles.sender}>{user ? "You" : "Lain"}</p>
        <p className={styles.messageContent}>{message.content}</p>
        {message.status === "interrupted" && <p className={styles.notice}>Response interrupted</p>}
      </article>
    </li>
  );
}
