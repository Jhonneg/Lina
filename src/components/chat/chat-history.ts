import { initializeSession, readPending, submissionConversation, type PendingStorage, type Submission } from "./chat-persistence";
import { apiError, ChatStreamError, isUuid } from "./chat-stream";

export type HistoryConversation = { id: string; title: string | null; createdAt: string; updatedAt: string };
export const HISTORY_PAGE_SIZE = 20;
export async function fetchHistoryPage(offset: number, signal: AbortSignal, fetchImpl: typeof fetch = fetch,
  ensureSession: () => Promise<string> = initializeSession) {
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new ChatStreamError("Invalid history page.");
  signal.throwIfAborted();
  await ensureSession();
  signal.throwIfAborted();
  const response = await fetchImpl(`/api/conversations?limit=${HISTORY_PAGE_SIZE}&offset=${offset}`, {
    credentials: "same-origin", cache: "no-store", signal,
  });
  let body;
  try { body = await response.json(); } catch { throw new ChatStreamError("Unable to load conversation history. Please try again."); }
  signal.throwIfAborted();
  if (!response.ok) throw apiError(body?.error, response.status);
  if (body?.ok !== true || !Array.isArray(body.conversations) || body.conversations.length > HISTORY_PAGE_SIZE ||
      body.pagination?.limit !== HISTORY_PAGE_SIZE || body.pagination?.offset !== offset) throw new ChatStreamError("Unable to read conversation history.");
  const items: HistoryConversation[] = body.conversations.map((item: HistoryConversation) => {
    if (!item || !isUuid(item.id) || (item.title !== null && (typeof item.title !== "string" || item.title.length > 200)) ||
        typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt)) ||
        typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt))) throw new ChatStreamError("Unable to read conversation history.");
    return { id: item.id, title: item.title, createdAt: item.createdAt, updatedAt: item.updatedAt };
  });
  const nextOffset: number | null = body.pagination.nextOffset;
  if (nextOffset !== null && (!Number.isInteger(nextOffset) || nextOffset !== offset + HISTORY_PAGE_SIZE || nextOffset > 10000)) throw new ChatStreamError("Invalid history pagination.");
  return { items, nextOffset };
}
export function groupHistory(items: HistoryConversation[], now?: Date) {
  if (items.length === 0) return [];
  now ??= new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  return ["Today", "Yesterday", "Previous"].map(label => ({ label, items: items.filter(item => {
    const time = Date.parse(item.createdAt);
    return label === "Today" ? time >= today : label === "Yesterday" ? time >= yesterday && time < today : time < yesterday;
  }) })).filter(group => group.items.length > 0);
}
export function historyTitle(item: HistoryConversation) { return item.title?.trim() || "Untitled conversation"; }
export function appendHistory(previous: HistoryConversation[], incoming: HistoryConversation[]) {
  const seen = new Set(previous.map(item => item.id));
  return [...previous, ...incoming.filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true; })];
}

const ARCHIVE_INDEX = "lain.pending-recovery.v1";
const archiveKey = (id: string) => `${ARCHIVE_INDEX}:${id}`;
function recoveryIds(storage: PendingStorage | undefined): string[] {
  try {
    const text = storage?.getItem(ARCHIVE_INDEX);
    if (!text || text.length > 100000) return [];
    const ids = JSON.parse(text);
    return Array.isArray(ids) ? ids.filter(isUuid) : [];
  } catch { return []; }
}
export function archiveSubmission(storage: PendingStorage | undefined, submission: Submission) {
  try {
    if (!storage) return false;
    storage.setItem(archiveKey(submission.requestId), JSON.stringify(submission));
    storage.setItem(ARCHIVE_INDEX, JSON.stringify([...new Set([...recoveryIds(storage), submission.requestId])]));
    return true;
  } catch { return false; }
}
export function archivedSubmission(storage: PendingStorage | undefined, conversationId: string, ownerId: string) {
  return recoveryIds(storage).map(id => readPending(storage, archiveKey(id)))
    .filter((item): item is Submission => Boolean(item && item.ownerId === ownerId && submissionConversation(item) === conversationId))
    .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}
export function forgetArchivedSubmission(storage: PendingStorage | undefined, requestId: string) {
  try {
    storage?.removeItem(archiveKey(requestId));
    storage?.setItem(ARCHIVE_INDEX, JSON.stringify(recoveryIds(storage).filter(id => id !== requestId)));
  } catch { /* Other recovery records are retained. */ }
}

export async function renameConversation(id: string, title: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<HistoryConversation> {
  if (!isUuid(id) || !title.trim() || title.length > 200) throw new ChatStreamError("Provide a title of at most 200 characters.", "INVALID_INPUT");
  const body = await manageConversation(id, "PATCH", signal, fetchImpl, { title: title.trim() });
  const item = body.conversation;
  if (item?.id !== id || typeof item.title !== "string" || !item.title.trim() || item.title.length > 200 ||
      !Number.isFinite(Date.parse(item.createdAt)) || !Number.isFinite(Date.parse(item.updatedAt))) throw new ChatStreamError("Unable to read the updated conversation.");
  return { id: item.id, title: item.title, createdAt: item.createdAt, updatedAt: item.updatedAt };
}
export async function deleteConversation(id: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!isUuid(id)) throw new ChatStreamError("Invalid conversation.", "INVALID_INPUT");
  const body = await manageConversation(id, "DELETE", signal, fetchImpl);
  if (body.deletedId !== id) throw new ChatStreamError("Unable to confirm conversation deletion.");
}
async function manageConversation(id: string, method: "PATCH" | "DELETE", signal: AbortSignal, fetchImpl: typeof fetch, data?: { title: string }) {
  signal.throwIfAborted();
  const response = await fetchImpl(`/api/conversations/${id}`, { method, credentials: "same-origin", signal,
    ...(data ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) } : {}) });
  let body;
  try { body = await response.json(); } catch { throw new ChatStreamError("Unable to manage this conversation. Please try again."); }
  if (!response.ok) throw apiError(body?.error, response.status);
  if (body?.ok !== true) throw new ChatStreamError("Unable to confirm the change. Please refresh history.");
  return body;
}
export function clearConversationRecovery(storage: PendingStorage | undefined, conversationId: string) {
  if (!isUuid(conversationId)) return;
  for (const requestId of recoveryIds(storage)) {
    const pending = readPending(storage, archiveKey(requestId));
    if (pending && submissionConversation(pending) === conversationId) forgetArchivedSubmission(storage, requestId);
  }
  const active = readPending(storage);
  if (active && submissionConversation(active) === conversationId) {
    try { storage?.removeItem("lain.pending-submission.v1"); } catch { /* In-memory recovery is also cleared by the hook. */ }
  }
}
