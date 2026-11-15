"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import styles from "./staging-access.module.css";

export default function StagingAccessPage() {
  const router = useRouter();
  const [secret, setSecret] = useState("");
  const [pending, setPending] = useState(false), [message, setMessage] = useState("");
  async function signIn(event: FormEvent) {
    event.preventDefault(); if (pending) return;
    setPending(true); setMessage("");
    try {
      const response = await fetch("/api/staging-access", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret }) });
      setSecret("");
      if (!response.ok) {
        setMessage(response.status === 429 ? "Too many attempts. Wait before trying again." : response.status === 401 ? "Invalid access credentials." : "Operator access is unavailable. Please try again later.");
        return;
      }
      router.replace("/"); router.refresh();
    } catch { setSecret(""); setMessage("Unable to connect. Please try again."); }
    finally { setPending(false); }
  }
  async function signOut() {
    if (pending) return; setPending(true);
    try {
      const response = await fetch("/api/staging-access", { method: "DELETE", credentials: "same-origin" });
      if (response.ok) { router.replace("/"); router.refresh(); } else setMessage("Unable to sign out. Please try again.");
    } catch { setMessage("Unable to connect. Please try again."); }
    finally { setPending(false); }
  }
  return <main className={styles.main}>
    <h1>Staging operator access</h1>
    <p>Conversation features are temporarily restricted to the operator.</p>
    <form onSubmit={signIn}>
      <label htmlFor="staging-secret">Staging access secret</label>
      <input id="staging-secret" type="password" autoComplete="current-password" maxLength={128} required value={secret} onChange={event => setSecret(event.target.value)} disabled={pending} />
      <button disabled={pending || !secret} type="submit">{pending ? "Please wait…" : "Sign in"}</button>
    </form>
    {message && <p role="alert">{message}</p>}
    <button type="button" onClick={() => void signOut()} disabled={pending}>Sign out</button>
    <Link href="/">Return to Lain</Link>
  </main>;
}
