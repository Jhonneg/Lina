import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { archiveSubmission, archivedSubmission, clearConversationRecovery, deleteConversation, renameConversation } from "../../src/components/chat/chat-history";
import { readPending, writePending, type Submission } from "../../src/components/chat/chat-persistence";
import { chatReducer, INITIAL_CHAT } from "../../src/components/chat/chat-state";
import { ChatStreamError } from "../../src/components/chat/chat-stream";

const ownerId = randomUUID();
function pending(id: string): Submission { return { requestId: randomUUID(), ownerId, userId: randomUUID(), conversationId: id, startedAt: Date.now(), messages: [{ role: "user", content: "Thought" }], partial: "Partial" }; }
function storage() { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; }

test("rename/delete client operations use same-origin credentials and validated response identifiers", async () => {
  const id = randomUUID();
  const item = await renameConversation(id, " New title ", new AbortController().signal, async (url, options) => {
    assert.equal(url, `/api/conversations/${id}`); assert.equal(options?.method, "PATCH"); assert.equal(options.credentials, "same-origin");
    assert.deepEqual(JSON.parse(String(options.body)), { title: "New title" });
    return Response.json({ ok: true, conversation: { id, title: "New title", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
  });
  assert.equal(item.title, "New title");
  await deleteConversation(id, new AbortController().signal, async (_url, options) => {
    assert.equal(options?.method, "DELETE"); assert.equal(options.credentials, "same-origin"); assert.equal(options.body, undefined);
    return Response.json({ ok: true, deletedId: id });
  });
  await assert.rejects(deleteConversation(id, new AbortController().signal, async () => Response.json({ ok: true, deletedId: randomUUID() })));
  await assert.rejects(renameConversation(id, " ", new AbortController().signal));
});

test("management errors remain accessible and never imply a successful deletion", async () => {
  const id = randomUUID();
  for (const status of [401, 404, 503]) await assert.rejects(deleteConversation(id, new AbortController().signal,
    async () => Response.json({ ok: false, error: { code: "NOT_FOUND", message: "Conversation unavailable." } }, { status })),
    error => error instanceof ChatStreamError && error.status === status);
});

test("successful deletion clears associated active/archived recovery and preserves unrelated records", () => {
  const browser = storage(), id = randomUUID(), other = randomUUID();
  const a = pending(id), b = pending(other), c = pending(id);
  c.conversationId = undefined; c.metadata = { requestId: c.requestId, conversationId: id, userMessageId: randomUUID(), assistantMessageId: randomUUID(), replayed: false };
  for (const item of [a, b, c]) archiveSubmission(browser, item);
  writePending(browser, c); clearConversationRecovery(browser, id);
  assert.equal(readPending(browser), null); assert.equal(archivedSubmission(browser, id, ownerId), null);
  assert.equal(archivedSubmission(browser, other, ownerId)?.requestId, b.requestId);
  writePending(browser, b); clearConversationRecovery(browser, id); assert.equal(readPending(browser)?.requestId, b.requestId);
});

test("active deletion reset invalidates late restore/stream work instead of recreating messages", () => {
  const intent = pending(randomUUID());
  let state = chatReducer(INITIAL_CHAT, { type: "start", requestId: "old", context: intent.messages,
    user: { id: intent.userId, role: "user", content: "Thought" } });
  state = chatReducer(state, { type: "reset" });
  state = chatReducer(state, { type: "delta", requestId: "old", text: "Late" });
  state = chatReducer(state, { type: "reconcile", requestId: "old", conversationId: intent.conversationId!, messages: [{ id: randomUUID(), role: "assistant", content: "Late saved text" }] });
  assert.deepEqual(state, INITIAL_CHAT);
});
