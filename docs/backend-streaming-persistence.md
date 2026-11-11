# Backend streaming persistence (Milestone 4C.2A)

`POST /api/chat/stream` supports two modes. No frontend changes are included.

- `{"mode":"ephemeral","messages":[...]}`: existing delta/done/error behavior,
  with no session or database required. For compatibility, the original
  `{"messages":[...]}` shape is an alias for this mode. Session/cookie presence
  never selects the mode. Persistence identifiers without `mode:"persisted"`
  are rejected, and persisted requests never fall back to ephemeral operation.
- `{"mode":"persisted","requestId":"UUID","conversationId":"optional UUID","messages":[...]}`:
  requires an existing valid anonymous-session cookie and an explicit matching
  Origin header. A missing/invalid/expired session returns 401, without creating
  a session. Missing and foreign conversations both return 404.

The client generates a UUID requestId once per logical submission and keeps the
entire normalized payload identical on retry, including whether conversationId
was originally omitted. The existing 32 KiB request, 20-message, 4,000-character
individual and 12,000-character combined limits apply. The final message must be
user-role text; **only that final user message is newly saved**. Earlier messages
remain caller-supplied model context, not additional inserts. Client-supplied
session IDs and unsupported fields are rejected. The backend does not yet rebuild
model context from stored history; frontend synchronization is a later task.

## SSE protocol and durability

Persisted responses emit `metadata` first:

```text
event: metadata
data: {"requestId":"UUID","conversationId":"UUID","userMessageId":"UUID","assistantMessageId":"UUID","replayed":false}

event: delta
data: {"text":"incremental assistant text"}

event: done
data: {"finishReason":"completed","saved":true}

```

Metadata is emitted only after the transaction committing the conversation (if
new), completed user message, pending assistant placeholder, and request claim
has succeeded. It does **not** mean assistant text has been saved. Deltas are
buffered in memory, bounded to 16,000 UTF-8 bytes, without per-delta DB writes.
`done` is emitted only after committing assistant content/status, request terminal
state and conversation updated_at in one transaction. It is the successful
assistant-durability acknowledgement. HTTP second-stage failures retain HTTP 200
but emit `error` with a safe `{code,message}` payload and never successful `done`.
Validation/ownership/claim failures before SSE return the existing JSON error
shape `{ok:false,error:{code,message}}` and an HTTP error status.

Handled disconnects/cancellation attempt to save accepted partial output as
`interrupted`; upstream failures/timeouts save it as `failed`. Empty failures
are represented by an empty terminal assistant message. A client disconnect
means no SSE acknowledgement can be delivered. Cancellation after generation
has completed and finalization has begun may still save a completed response.
A failed database finalization produces `PERSISTENCE_UNAVAILABLE`, with no done;
its outcome may be uncertain if the connection failed around commit. Retry with
the original request ID to discover committed state, not a new ID.

## Idempotency, crashes and recovery

Migration `0001_stream_request_idempotency.sql` adds a pending message status and
stream_requests with a UNIQUE(session_id, request_id) constraint and unique
message references. A PostgreSQL transaction advisory lock serializes a given
session/request pair. The same transaction performs ownership checks and creates
exactly one user/assistant pair. Any failure rolls back the whole claim. All
message and request finalization queries include SQL ownership conditions.

A fingerprint covers the normalized messages and originally supplied
conversationId. Conflicting reuse returns 409 REQUEST_CONFLICT. A matching active
claim returns 409 REQUEST_IN_PROGRESS without starting another generation.
Matching terminal retries replay metadata (replayed:true) and saved text. Completed
results end with done; interrupted/failed results end with REQUEST_INTERRUPTED or
REQUEST_FAILED error. **Terminal retries never regenerate**. A different request ID
is a new submission and inserts a new user message; it is not a retry mechanism.

The 25-second request/generation deadline remains, followed by best-effort database
finalization; DB statements/locks have 5s/4s server-side timeouts. Deployment must
allow time for this cleanup; SQL timeouts do not guarantee a bound during a network
partition. Claims become stale after 60 seconds. A later matching retry atomically
marks a stale running claim and its assistant failed and replays that result.
It never takes over generation. Late finalizers are rejected after recovery.
There is no background sweeper: unretried crashed requests can remain pending.

There is **no guarantee of buffered assistant-text durability across abrupt
process termination or database failure**. Only the user and empty pending
assistant are committed before generation. Uncommitted deltas can be lost; no
checkpointing or resumable model generation is implemented. Do not delete request
or message records independently and then reuse IDs; idempotency lasts as long as
its records, which currently cascade with the owning session/conversation.

Apply migrations explicitly using `npm run db:migrate` against a chosen target.
`npm run test:stream:postgres` creates, migrates, tests and removes only a uniquely
named disposable local database. It never resets or mutates lain_dev. Tests use
injected deterministic adapters and make no OpenAI requests. Public deployment
still requires rate/concurrency/abuse protections and infrastructure verification.
