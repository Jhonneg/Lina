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
session credentials. It is cleared on confirmed completion or New Chat. Storage
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
