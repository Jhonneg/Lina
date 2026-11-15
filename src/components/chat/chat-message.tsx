"use client";

import { memo } from "react";
import { MarkdownResponse } from "./markdown-response";
import { CopyButton } from "./copy-button";
import type { Message } from "./chat-types";
import styles from "./chat.module.css";
import voiceStyles from "./chat-voice.module.css";

export const ChatMessage = memo(function ChatMessage({ message, transmitting = true, onRead, reading = false }: { message: Message; transmitting?: boolean; onRead?: (message: Message) => void; reading?: boolean }) {
  const user = message.role === "user";
  return (
    <li className={user ? styles.userMessage : styles.assistantMessage}>
      <article aria-label={user ? "You" : "Lain"} data-message-id={message.id} data-response-status={message.status}>
        <p className={styles.sender}>{user ? "You" : "Lain"}</p>
        {user ? <p className={styles.messageContent}>{message.content}</p>
          : <MarkdownResponse content={message.content} streaming={message.status === "streaming" && transmitting} />}
        {!user && message.status === "complete" && message.content && <CopyButton text={message.content} label="Copy response" />}
        {!user && message.status === "complete" && message.content && onRead && <button type="button" className={voiceStyles.read} aria-label={reading ? "Stop reading response" : "Read response aloud"} onClick={() => onRead(message)}>{reading ? "Stop voice" : "Read aloud"}</button>}
        {message.status === "interrupted" && <p className={styles.notice}>Response interrupted</p>}
        {message.status === "failed" && <p className={styles.notice}>Response failed</p>}
        {message.status === "pending" && <p className={styles.notice}>Response not yet saved</p>}
      </article>
    </li>
  );
});
