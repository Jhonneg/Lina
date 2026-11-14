import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { appendHistory, archiveSubmission, archivedSubmission, fetchHistoryPage, forgetArchivedSubmission, groupHistory, historyTitle,
  type HistoryConversation } from "../../src/components/chat/chat-history";
import { readPending, submissionConversation, writePending, type Submission } from "../../src/components/chat/chat-persistence";
import { ChatStreamError } from "../../src/components/chat/chat-stream";

const ownerId = randomUUID();
function item(date = new Date(), title: string | null = null): HistoryConversation {
  return { id: randomUUID(), title, createdAt: date.toISOString(), updatedAt: date.toISOString() };
}
function pending(conversationId?: string): Submission {
  return { requestId: randomUUID(), ownerId, userId: randomUUID(), startedAt: Date.now(), conversationId,
    messages: [{ role: "user", content: "Pending thought" }], partial: "Partial response" };
}
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
function response(items: HistoryConversation[], offset = 0, nextOffset: number | null = null) {
  return Response.json({ ok: true, conversations: items, pagination: { limit: 20, offset, nextOffset } });
}

test("history reuses session initialization and fetches bounded pages with same-origin credentials", async () => {
  let sessions = 0;
  const row = item();
  const result = await fetchHistoryPage(20, new AbortController().signal, async (url, options) => {
    assert.equal(url, "/api/conversations?limit=20&offset=20");
    assert.equal(options?.credentials, "same-origin"); assert.equal(options?.cache, "no-store");
    assert.equal(options?.method, undefined);
    return response([row], 20, 40);
  }, async () => { sessions++; return ownerId; });
  assert.equal(sessions, 1); assert.deepEqual(result, { items: [row], nextOffset: 40 });
});

test("history groups by local calendar Today, Yesterday, Previous with readable title fallback", () => {
  const now = new Date(2026, 10, 14, 12);
  const today = item(new Date(2026, 10, 14, 0, 1));
  const yesterday = item(new Date(2026, 10, 13, 23, 59), " Saved thought ");
  const previous = item(new Date(2026, 10, 12, 23, 59));
  assert.deepEqual(groupHistory([today, yesterday, previous], now).map(group => ({ label: group.label, ids: group.items.map(x => x.id) })), [
    { label: "Today", ids: [today.id] }, { label: "Yesterday", ids: [yesterday.id] }, { label: "Previous", ids: [previous.id] },
  ]);
  assert.equal(historyTitle(today), "Untitled conversation"); assert.equal(historyTitle(yesterday), "Saved thought");
  assert.deepEqual(groupHistory([], now), []);
});

test("Load more preserves server order and avoids duplicate conversations", () => {
  const a = item(), b = item(), c = item();
  assert.deepEqual(appendHistory([a, b], [b, c, c]).map(x => x.id), [a.id, b.id, c.id]);
});

test("history handles empty/error responses and rejects invalid pagination or payloads", async () => {
  const initialize = async () => ownerId, signal = new AbortController().signal;
  assert.deepEqual(await fetchHistoryPage(0, signal, async () => response([]), initialize), { items: [], nextOffset: null });
  for (const status of [401, 503]) {
    await assert.rejects(fetchHistoryPage(0, signal, async () => Response.json({ ok: false, error: { code: "SESSION_REQUIRED", message: "Please reconnect." } }, { status }), initialize),
      error => error instanceof ChatStreamError && error.status === status);
  }
  for (const offset of [-1, 10001, 1.5]) await assert.rejects(fetchHistoryPage(offset, signal));
  for (const fake of [response([], 0, 0), response([], 20), response([{ ...item(), id: "invalid" }]), response(Array.from({ length: 21 }, () => item()))]) {
    await assert.rejects(fetchHistoryPage(0, signal, async () => fake, initialize));
  }
});

test("closed or superseded history requests cannot deliver stale pages even if fetch ignores abort", async () => {
  const abort = new AbortController(); let resolve!: (value: Response) => void;
  const result = fetchHistoryPage(0, abort.signal, () => new Promise<Response>(done => { resolve = done; }), async () => ownerId);
  await Promise.resolve(); abort.abort(); resolve(response([item()]));
  await assert.rejects(result, { name: "AbortError" });
  let calls = 0;
  await assert.rejects(fetchHistoryPage(0, abort.signal, async () => { calls++; return response([]); }, async () => ownerId), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("switching preserves pending request ID, payload and partial text independently for each conversation", () => {
  const browser = storage(), a = pending(randomUUID()), b = pending(randomUUID());
  a.metadata = { requestId: a.requestId, conversationId: a.conversationId!, userMessageId: randomUUID(), assistantMessageId: randomUUID(), replayed: false };
  writePending(browser, a); assert.ok(archiveSubmission(browser, a));
  writePending(browser, b); assert.ok(archiveSubmission(browser, b));
  const recovered = archivedSubmission(browser, a.conversationId!, ownerId)!;
  assert.equal(recovered.requestId, a.requestId); assert.equal(recovered.partial, a.partial);
  assert.deepEqual(recovered.messages, a.messages); assert.deepEqual(recovered.metadata, a.metadata);
  assert.equal(submissionConversation(recovered), a.conversationId);
  assert.equal(archivedSubmission(browser, a.conversationId!, randomUUID()), null);
  assert.equal(readPending(browser)?.requestId, b.requestId);
});

test("New Chat clears only the active slot; confirmed completion forgets only its own recovery", () => {
  const browser = storage(), a = pending(randomUUID()), b = pending(randomUUID());
  archiveSubmission(browser, a); archiveSubmission(browser, b);
  writePending(browser, a); writePending(browser, null);
  assert.equal(readPending(browser), null);
  assert.equal(archivedSubmission(browser, a.conversationId!, ownerId)?.requestId, a.requestId);
  forgetArchivedSubmission(browser, a.requestId);
  assert.equal(archivedSubmission(browser, a.conversationId!, ownerId), null);
  assert.equal(archivedSubmission(browser, b.conversationId!, ownerId)?.requestId, b.requestId);
  assert.equal(archiveSubmission(undefined, a), false); // Hook keeps an in-memory fallback.
});

test("recovery retains the original omitted conversation field after metadata resolves ownership", () => {
  const browser = storage(), a = pending();
  const id = randomUUID();
  a.metadata = { requestId: a.requestId, conversationId: id, userMessageId: randomUUID(), assistantMessageId: randomUUID(), replayed: false };
  archiveSubmission(browser, a);
  const restored = archivedSubmission(browser, id, ownerId)!;
  assert.equal(restored.conversationId, undefined); assert.equal(restored.metadata?.conversationId, id);
  assert.equal(restored.requestId, a.requestId);
});
