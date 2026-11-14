"use client";

import { useEffect, useState } from "react";
import styles from "./markdown.module.css";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [status, setStatus] = useState<"ready" | "copied" | "error">("ready");
  useEffect(() => {
    if (status === "ready") return;
    const timer = setTimeout(() => setStatus("ready"), 2500);
    return () => clearTimeout(timer);
  }, [status]);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setStatus("copied"); }
    catch { setStatus("error"); }
  }
  return <span className={styles.copyControl}>
    <button type="button" className={styles.copy} aria-label={label} onClick={() => { void copy(); }}>
      {status === "copied" ? "Copied" : "Copy"}
    </button>
    <span role="status" className={status === "error" ? styles.copyError : styles.srOnly}>
      {status === "copied" ? "Copied to clipboard." : status === "error" ? "Copy unavailable. Select and copy the text." : ""}
    </span>
  </span>;
}
