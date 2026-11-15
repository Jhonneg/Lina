"use client";
import { useEffect, useState } from "react";
import { ChatWindow } from "./chat-window";

/** Keep the same canvas mounted while the stateless access check resolves. */
export function StagingChat() {
  const [authorized, setAuthorized] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/staging-access", { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) return;
        const value = await response.json();
        if (!controller.signal.aborted) setAuthorized(value.ok === true && value.authorized === true);
      }).catch(() => { /* Leave conversational features restricted. */ });
    return () => controller.abort();
  }, []);
  return <ChatWindow stagingRestricted={!authorized} />;
}
