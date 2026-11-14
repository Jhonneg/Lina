"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { chatReducer, conversationContext, INITIAL_CHAT, MAX_MESSAGE_CHARS, type ChatAction } from "./chat-state";
import { ChatStreamError, isUuid, streamChat } from "./chat-stream";
import { initializeSession, pendingMessages, readPending, reconcileMessages, restoreConversation, savedSubmission,
  submissionConversation, writePending, type PendingStorage, type Submission } from "./chat-persistence";
import { archiveSubmission, archivedSubmission, clearConversationRecovery, forgetArchivedSubmission } from "./chat-history";
import type { Message } from "./chat-types";

type Operation = { id: string; abort: AbortController; reconciliation?: AbortController; stopped: boolean };
function storage(): PendingStorage | undefined { try { return window.sessionStorage; } catch { return undefined; } }
function urlConversation() { return new URL(window.location.href).searchParams.get("conversation"); }
function setConversationUrl(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("conversation", id); else url.searchParams.delete("conversation");
  window.history.replaceState(window.history.state, "", url);
}
const CHECK_STATUS = "The response was not confirmed saved. Check its saved status before continuing.";

export function usePersistentChat() {
  const [state, setState] = useState(INITIAL_CHAT);
  const snapshot = useRef(INITIAL_CHAT);
  const [loading, setLoading] = useState<string | null>("Connecting");
  const [blocked, setBlocked] = useState(true);
  const [retryAt, setRetryAt] = useState(0);
  const [bootError, setBootError] = useState(false);
  const owner = useRef<string | null>(null);
  const needsSession = useRef(false);
  const submission = useRef<Submission | null>(null);
  const recoveries = useRef(new Map<string, Submission>());
  const deletedIds = useRef(new Set<string>());
  const operation = useRef<Operation | null>(null);
  const boot = useRef<AbortController | null>(null);
  const apply = useCallback((action: ChatAction) => {
    const next = chatReducer(snapshot.current, action);
    snapshot.current = next;
    setState(next);
  }, []);
  const preserve = useCallback((value: Submission) => {
    recoveries.current.set(value.requestId, value);
    archiveSubmission(storage(), value);
  }, []);
  const remember = useCallback((value: Submission | null, keepRecovery = false) => {
    const previous = submission.current;
    if (!value && previous && !keepRecovery) {
      recoveries.current.delete(previous.requestId);
      forgetArchivedSubmission(storage(), previous.requestId);
    }
    submission.current = value;
    writePending(storage(), value);
  }, []);
  const abortWork = useCallback(() => {
    operation.current?.abort.abort();
    operation.current?.reconciliation?.abort();
    operation.current = null;
    boot.current?.abort();
  }, []);

  const initialize = useCallback(async (forceSession = false) => {
    const activePending = submission.current ?? readPending(storage());
    if (activePending) { preserve(activePending); writePending(storage(), activePending); }
    abortWork();
    apply({ type: "restore", messages: snapshot.current.messages, conversationId: urlConversation() });
    const controller = new AbortController(); boot.current = controller;
    setLoading("Connecting"); setBlocked(true); setBootError(false); setRetryAt(0);
    try {
      const ownerId = await initializeSession(forceSession);
      if (controller.signal.aborted) return;
      owner.current = ownerId; needsSession.current = false;
      const id = urlConversation();
      if (id && deletedIds.current.has(id)) throw new ChatStreamError("This conversation was deleted. Start a new chat.", "NOT_FOUND", 404);
      let pending = readPending(storage());
      if (pending && submissionConversation(pending) !== id) pending = null;
      if (!pending && id) pending = [...recoveries.current.values()]
        .filter(item => item.ownerId === ownerId && submissionConversation(item) === id)
        .sort((a, b) => b.startedAt - a.startedAt)[0] ?? archivedSubmission(storage(), id, ownerId);
      if (pending && pending.ownerId !== ownerId) throw new ChatStreamError("The previous browser session is unavailable. Start a new chat.");
      submission.current = pending;
      writePending(storage(), pending);
      let messages = pending ? pendingMessages(pending) : [];
      if (id) {
        if (!isUuid(id)) throw new ChatStreamError("This conversation is unavailable. Try again or start a new chat.");
        setLoading("Restoring conversation");
        const server = await restoreConversation(id, controller.signal);
        if (controller.signal.aborted || deletedIds.current.has(id)) return;
        messages = reconcileMessages(server, messages, pending);
        if (savedSubmission(server, pending)) { remember(null); pending = null; }
      }
      const uncertain = Boolean(pending && (!pending.metadata || messages.some(message => message.id === pending!.metadata?.assistantMessageId && message.status === "pending")));
      const unresolved = messages.some(message => message.status === "pending");
      apply({ type: "restore", messages, conversationId: id, error: pending || unresolved ? "A previous response did not finish. Check its saved status; restoration will not generate a new response." : null });
      setBlocked(uncertain || unresolved);
      setRetryAt(pending?.retryAt ?? 0);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ChatStreamError && error.status === 401) needsSession.current = true;
      const message = error instanceof ChatStreamError ? error.message : "Unable to connect or restore this conversation. Please try again.";
      apply({ type: "restore", messages: snapshot.current.messages, conversationId: urlConversation(), error: message });
      setBootError(true); setBlocked(true);
    } finally {
      if (boot.current === controller && !controller.signal.aborted) setLoading(null);
    }
  }, [abortWork, apply, remember, preserve]);

  useEffect(() => {
    const initialization = setTimeout(() => { void initialize(); }, 0);
    const navigate = () => { void initialize(); };
    const save = () => { if (submission.current) writePending(storage(), submission.current); };
    window.addEventListener("popstate", navigate);
    window.addEventListener("pagehide", save);
    return () => { clearTimeout(initialization); save(); abortWork(); window.removeEventListener("popstate", navigate); window.removeEventListener("pagehide", save); };
  }, [initialize, abortWork]);
  useEffect(() => {
    if (!retryAt) return;
    const timer = setTimeout(() => setRetryAt(0), Math.max(0, retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [retryAt]);

  async function generate(intent: Submission, user?: Message) {
    const id = submissionConversation(intent);
    if (operation.current || (id && deletedIds.current.has(id))) return;
    const current: Operation = { id: crypto.randomUUID(), abort: new AbortController(), stopped: false };
    operation.current = current;
    const live = () => operation.current === current;
    setLoading(null); setBlocked(false); setRetryAt(0);
    apply({ type: "start", requestId: current.id, context: intent.messages, user,
      userId: intent.metadata?.userMessageId ?? intent.userId, assistantId: intent.metadata?.assistantMessageId ?? intent.requestId });
    try {
      let replay = false, received = "";
      await streamChat(intent.messages, current.abort.signal, text => {
        if (!live()) return;
        received += text;
        intent.partial = replay && intent.partial.startsWith(received) ? intent.partial : received;
        apply({ type: "delta", requestId: current.id, text });
      }, fetch, { requestId: intent.requestId, conversationId: intent.conversationId, onMetadata: metadata => {
        if (!live()) return;
        intent.metadata = metadata; replay = metadata.replayed;
        if (deletedIds.current.has(metadata.conversationId)) { conversationDeleted(metadata.conversationId); return; }
        remember(intent); setConversationUrl(metadata.conversationId);
        apply({ type: "metadata", requestId: current.id, metadata });
      } });
      if (!live() || current.abort.signal.aborted) return;
      apply({ type: "finish", requestId: current.id, outcome: "complete" });
      remember(null); setBlocked(false);
    } catch (failure) {
      if (!live()) return;
      apply({ type: "settle", requestId: current.id });
      remember(intent); setLoading("Checking saved response");
      let error = current.stopped ? "Generation stopped. Received text is preserved." : failure instanceof ChatStreamError ? failure.message : CHECK_STATUS;
      let outcome: "complete" | "interrupted" | "failed" = failure instanceof ChatStreamError && ["REQUEST_FAILED", "AI_UNAVAILABLE", "AI_TIMEOUT"].includes(failure.code) ? "failed" : "interrupted";
      let uncertain = true;
      const id = submissionConversation(intent);
      if (failure instanceof ChatStreamError && failure.status === 401) needsSession.current = true;
      if (id && intent.metadata && !needsSession.current) {
        const reconciliation = new AbortController(); current.reconciliation = reconciliation;
        try {
          const server = await restoreConversation(id, reconciliation.signal);
          if (!live()) return;
          apply({ type: "reconcile", requestId: current.id, conversationId: id,
            messages: reconcileMessages(server, snapshot.current.messages, intent) });
          if (savedSubmission(server, intent)) { outcome = "complete"; error = ""; uncertain = false; remember(null); }
          else {
            const stored = server.find(message => message.id === intent.metadata?.assistantMessageId);
            if (stored && stored.status !== "pending") { uncertain = false; outcome = stored.status === "failed" ? "failed" : "interrupted"; }
          }
        } catch { if (!live()) return; error += " Saved status could not be checked."; }
      }
      if (!live()) return;
      if (failure instanceof ChatStreamError && failure.code === "REQUEST_IN_PROGRESS" && uncertain) {
        intent.retryAt = Date.now() + 60000;
        setRetryAt(intent.retryAt); remember(intent);
        error = "This response is still processing. Check again in one minute; another response will not be generated.";
      }
      apply({ type: "finish", requestId: current.id, outcome, error: error || undefined });
      setBlocked(uncertain);
    } finally {
      if (live()) { operation.current = null; setLoading(null); writePending(storage(), submission.current); }
    }
  }

  function send(text: string): boolean {
    if (!text || text.length > MAX_MESSAGE_CHARS || loading || blocked || operation.current || !owner.current) return false;
    const user: Message = { id: crypto.randomUUID(), role: "user", content: text, status: "complete" };
    const intent: Submission = { requestId: crypto.randomUUID(), ownerId: owner.current, startedAt: Date.now(),
      ...(snapshot.current.conversationId ? { conversationId: snapshot.current.conversationId } : {}),
      messages: conversationContext([...snapshot.current.messages, user]), userId: user.id, partial: "" };
    remember(intent); void generate(intent, user); return true;
  }
  function stop() {
    const current = operation.current;
    if (!current) return;
    current.stopped = true; current.abort.abort();
    apply({ type: "settle", requestId: current.id });
    writePending(storage(), submission.current);
  }
  function reset() {
    if (submission.current) preserve(submission.current);
    abortWork(); remember(null, true); setConversationUrl(null); apply({ type: "reset" });
    setRetryAt(0); setBootError(false); setLoading(null); setBlocked(false);
    if (!owner.current || needsSession.current) void initialize(needsSession.current);
  }
  function selectConversation(id: string) {
    if (!isUuid(id) || deletedIds.current.has(id)) return;
    if (snapshot.current.conversationId === id && !bootError) return;
    setConversationUrl(id);
    void initialize();
  }
  function conversationDeleted(id: string) {
    deletedIds.current.add(id);
    clearConversationRecovery(storage(), id);
    for (const [key, pending] of recoveries.current) {
      if (submissionConversation(pending) === id) recoveries.current.delete(key);
    }
    const associated = submission.current && submissionConversation(submission.current) === id;
    if (snapshot.current.conversationId === id || urlConversation() === id || associated) {
      if (submission.current && !associated) preserve(submission.current);
      abortWork(); submission.current = null;
      setConversationUrl(null); apply({ type: "reset" });
      setRetryAt(0); setBootError(false); setLoading(null); setBlocked(false);
    }
  }
  function retry() {
    if (loading || operation.current || retryAt > Date.now()) return;
    if (bootError || needsSession.current || !submission.current) { void initialize(needsSession.current); return; }
    void generate(submission.current);
  }
  return { state, loading, blocked, bootError, retryAt, send, stop, reset, retry, selectConversation, conversationDeleted,
    retryLabel: bootError ? "Try again" : retryAt ? "Check again in one minute" : "Check saved response" };
}
