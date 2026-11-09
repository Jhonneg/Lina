import type { Message } from "./chat-types";
import styles from "./chat.module.css";

export function ChatMessage({ message }: { message: Message }) {
  const user = message.role === "user";
  return (
    <li className={user ? styles.userMessage : styles.assistantMessage}>
      <article aria-label={user ? "You" : "Lain"} data-message-id={message.id}>
        <p className={styles.sender}>{user ? "You" : "Lain"}</p>
        <p className={styles.messageContent}>{message.content}</p>
      </article>
    </li>
  );
}
