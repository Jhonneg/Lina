import "server-only";

/** Deterministic, Unicode-safe first-message title; no model call. */
export function automaticConversationTitle(content: string): string {
  const normalized = content.replace(/\s+/gu, " ").trim();
  const characters = Array.from(normalized);
  if (characters.length <= 60) return normalized || "Untitled conversation";
  const prefix = characters.slice(0, 59).join("");
  const boundary = prefix.lastIndexOf(" ");
  return (boundary >= 30 ? prefix.slice(0, boundary) : prefix).trimEnd() + "…";
}
