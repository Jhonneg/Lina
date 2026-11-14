# Frontend persistence (Milestone 4C.2B)

The chat initializes POST /api/session with same-origin browser credentials using
a shared single-flight initializer. It never reads or stores the HttpOnly token.
Session failures have an accessible retry action. The safe server session ID is
used only to detect a changed browser session; it is never sent as ownership proof.

The current conversation UUID lives in the `conversation` URL query parameter.
On load/navigation the client restores messages using paginated GET requests of
50 messages, following validated offsets up to the API's 10,000 offset cap. A UUID
is only a reference: the server still verifies cookie ownership. Restoration never
calls the generation endpoint. Missing/inaccessible conversations offer retry and
New Chat; New Chat clears the local reference without deleting saved data.

Each logical submission gets crypto.randomUUID(). A per-tab sessionStorage record
keeps the exact original request payload, request/message IDs, safe owner ID, retry
time, and any unacknowledged partial text. It contains conversation text but no
session credentials. The active slot is cleared on confirmed completion or New Chat; unfinished
recovery records are archived separately when navigating or starting a new chat. Storage
is best effort; if browser storage is blocked, in-memory retry works, but an
interrupted request cannot reliably be retried across reload without that record.
A changed browser session cannot replay an old submission under a new identity.

Metadata supplies authoritative IDs; retries retain the original conversationId
field (including its omission) and replace/reconcile the same local messages.
Only done(saved:true), or a server retrieval confirming a completed assistant
message, marks completion. Failure/Stop preserves received partial text and tries
a GET reconciliation. Unknown outcomes block new submissions until checked or
New Chat is selected. REQUEST_IN_PROGRESS applies a manual 60-second retry
cooldown; there is no automatic regeneration. Failed/interrupted terminal retries
only replay backend results. Restored pending messages without a recoverable
submission can be rechecked by retrieval, but the current backend exposes no
request-ID lookup for recovering an intent lost from sessionStorage.

The orb stays Idle during restoration, Thinking before text, Talking during
streaming, and Idle on completion/failure/Stop. Existing layout, shaders, scrolling,
keyboard behavior and reduced-motion preferences are retained. No history UI or
schema/backend changes are included. PostgreSQL must be running with the existing
migrations applied; mock AI mode avoids OpenAI requests.


## Conversation history drawer (Milestone 4D.1)

The header toggle opens a modal overlay without changing the chat grid or orb
mount. It loads GET /api/conversations in pages of 20 using the shared session
initializer, refreshes on reopening or a newly resolved conversation ID, and
ignores aborted/stale responses. Groups use local calendar dates and creation
timestamps; untitled entries have a readable fallback. Native dialog focus
containment, Escape, backdrop dismissal and focus restoration are supported;
transitions last 220ms and are disabled for reduced motion.

Selecting an entry changes the existing conversation URL reference and invokes
the same restoration/cancellation flow. Pending payloads and partial text are
archived by request ID in per-tab sessionStorage and restored only for the matching
conversation and browser-session metadata. A memory fallback retains recovery
while mounted if storage is unavailable; reload recovery still requires storage.
Old request callbacks cannot update the newly selected conversation. New Chat
archives unfinished recovery and clears only active UI/URL state, never database
records. Recovery records are removed after confirmed completion. Records whose
conversation ID was never received are retained, but the existing backend has no
request-ID lookup to associate them with a history entry automatically.

## Conversation management (Milestone 4D.2)

The server derives a title from the first persisted user message when the stored
conversation title is null. Whitespace is normalized, titles are shortened to at
most 60 Unicode code points at a sensible word boundary, and existing/manual
titles are never overwritten. Existing untitled conversations receive a title on
a later user append using their earliest stored user message; no bulk backfill or
extra AI request is performed.

PATCH /api/conversations/[id] accepts only {title: non-empty string}, with the
existing 200 UTF-16-code-unit title bound. DELETE on that route permanently removes
the owned conversation and cascades messages and stream request records. Both
require a valid cookie session and a matching Origin; foreign/missing IDs return
the same 404. Failures have safe JSON errors. There is no schema migration.

The entry action menu supports Rename (Save/Cancel) and explicit Delete
confirmation. The existing drawer refreshes after success. Successful deletion
clears only associated local recovery records; deleting the active conversation
also cancels work and resets the chat without archiving its deleted submission.
Deleted IDs are guarded against late restoration/metadata callbacks in this tab.

Conversation-row locks serialize append/title assignment, rename, deletion and
stream finalization. Finalization only updates existing owned rows and never
recreates a deleted conversation. Another tab's active provider may continue until
its normal deadline, but it cannot save into the deleted conversation. Deletion
also removes idempotency receipts: never retry deleted submissions, especially an
original request whose conversationId was omitted. Explicitly submitting a fresh
request after deletion can create a new conversation; no deletion tombstones or
cross-tab broadcast mechanism have been added. Unknown network outcomes around a
DELETE acknowledgement still require refreshing history to confirm the result.
