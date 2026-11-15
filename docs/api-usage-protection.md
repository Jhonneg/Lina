# Persistent API usage protection (5F.4)

All real OpenAI calls through `/api/chat`, `/api/chat/stream`, `/api/voice`,
and `/api/dev/cloud-voice` require an existing anonymous session and pass through
`src/server/usage/`. Development text mocks remain free and database-independent.
Both voice endpoints remain **development-only**; this milestone does not approve
public production voice. Session tokens stay in the existing HttpOnly cookie.

## Setup and defaults

Review and apply `drizzle/0002_sleepy_jane_foster.sql` explicitly with
`npm run db:migrate` against your intended database. No startup migrations run.
Configure the server-only variables in `.env.example`. Missing database,
invalid settings, missing text prices, or accounting failures block paid calls.

| Setting | Default | Scope |
| --- | --- | --- |
| `USAGE_TEXT_HOURLY_LIMIT` / `USAGE_TEXT_DAILY_LIMIT` | 20 / 100 | Text attempts per session |
| `USAGE_SPEECH_HOURLY_LIMIT` / `USAGE_SPEECH_DAILY_LIMIT` | 20 / 60 | Speech segments per session |
| `USAGE_SPEECH_MINUTE_LIMIT` | 3 | Speech segments per rolling minute/session |
| `USAGE_SESSION_CONCURRENCY` / `USAGE_GLOBAL_CONCURRENCY` | 2 / 4 | Combined text and speech |
| `USAGE_IP_MINUTE_LIMIT` / `USAGE_IP_HOURLY_LIMIT` | 20 / 100 | Combined paid attempts per trusted IP |
| `USAGE_DAILY_BUDGET_USD` | 1 | Shared UTC-day budget, including reservations |

Hourly/minute limits are rolling windows; daily limits reset at UTC midnight.
Zero quotas/budget disable new admissions. Concurrency must be at least one.
Set `USAGE_TEXT_INPUT_USD_PER_MILLION` and
`USAGE_TEXT_OUTPUT_USD_PER_MILLION` to current prices for `OPENAI_MODEL`.
`USAGE_TEXT_CACHED_USD_PER_MILLION` defaults to the input price and cannot exceed
it. Positive input/output prices are required; no model price is guessed.

Speech uses the selected `gpt-realtime-2.1-mini` prices: text input $0.60,
cached text $0.06, text output $2.40, audio output $20 per million tokens.
These were checked against [OpenAI pricing](https://developers.openai.com/api/docs/pricing)
and the [model documentation](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini).
Review tariffs when changing a model or when provider prices change.

`USAGE_TRUSTED_PROXY=none` ignores every forwarded address in local development.
Production paid requests fail closed with this setting. The supported production
mode is `vercel`, requiring `VERCEL=1` and a random server-only
`USAGE_IP_HMAC_KEY` of at least 32 characters. Only
[`x-vercel-forwarded-for`](https://vercel.com/docs/headers/request-headers)
is accepted, as one valid IP; generic `Forwarded`/`X-Forwarded-For` are ignored.
This depends on genuine Vercel ingress overwriting the header and the origin
being inaccessible through an untrusted bypass. Other deployments need a reviewed
trusted-ingress adapter before paid use.

Raw addresses are never stored or logged. Canonical IPs are HMAC-SHA256 hashed
with a UTC-day salt, limiting correlation across days. IP limits survive cookie
rotation and session deletion; anonymous session quotas alone cannot stop cookie
rotation. The hash rotates at midnight, so IP rolling windows also reset then.
Shared/NAT addresses may share limits; address changes/IPv6 rotation can evade
per-IP limits. The global budget still applies.

## Accounting and idempotency

`usage_reservations` holds model, snapshotted prices, integer micro-USD costs,
request/segment identifiers, timestamps, state, token counts and a SHA-256 request
fingerprint. It does not contain conversation text, raw addresses or credentials.
`usage_utterances` holds aggregate speech character, duration and PCM byte budgets.
Session deletion sets their foreign keys to null rather than erasing spend.
There is no automatic ledger retention/pruning job yet; do not delete current
budget-window records. Fingerprints can correlate identical inputs within this
ledger; they are not a substitute for encryption or a retention policy.

A short PostgreSQL advisory transaction lock serializes admission and settlement
across application instances. The transaction checks quotas, active leases and
shared reserved/charged spend before inserting a unique
`(session_id, kind, request_id, segment)` reservation. No provider call starts
until a separate one-time `start()` commit succeeds. Database writes have bounded
statement/lock timeouts. Accounting failure returns safe 503 errors; limits return
429 and `Retry-After` before streaming, or structured SSE errors with `retryAfter`
after headers. Existing accessible chat/voice error slots show these messages.

Persisted text reuses its body `requestId`; reservation and new conversation claim
share one transaction. A rejected admission creates no conversation/messages.
Completed persisted retries replay stored text without another paid request.
Non-persistent paid text and lab speech require an `Idempotency-Key` UUID header
in addition to their existing body. Main speech uses its existing body request ID
and segment index. Duplicate/conflicting attempts return 409 and never dispatch
again, even after cancellation or process restart. Non-persistent results are not
cached for replay: explicitly submit a new logical request to generate again.

Each progressive speech segment consumes its own quota, concurrency slot and
reservation. The sequence still has at most three ordered segments, 800 cumulative
characters (including separators), 30 seconds cumulative upstream time and 60
seconds PCM. Its previous segment must settle before the next is admitted;
upcoming synthesis can still overlap playback. Expired, failed or cancelled
sequences cannot be continued. These checks do not change the approved voice/DSP.

Reservations estimate input tokens using UTF-8 bytes plus 2,048 tokens of overhead,
and the provider output caps (768 text tokens or 2,048 speech tokens charged at
the higher audio rate). Completed provider token usage settles the actual cost;
unused reservation is released before successful `done`/HTTP completion. An
actual overrun is charged in full, blocking subsequent admissions if needed.
No-usage failures, disconnections and cancellations keep the maximum reservation.
An attempt proven not dispatched is voided at zero cost but still counts toward
attempt quotas. A crash after dispatch keeps its maximum charge. A 90-second
lease bounds concurrency recovery, exceeding existing 25/30-second request limits;
expired started records retain their charge and cannot dispatch again. Expired
unstarted reservations are voided on the next admission. No automatic paid retry
or lease takeover occurs.

This is estimated application accounting, not a guaranteed provider invoice cap:
token overhead, tariffs, provider-side cancellation timing, taxes and regional
uplifts can differ. Final usage may never arrive; conservative charges can exceed
actual spend. Lease recovery assumes the existing bounded, abortable provider
requests; a dead/stalled process cannot offer absolute distributed execution
concurrency guarantees. Use provider/project spending controls as an additional
layer. This does not replace the future public deployment security review.

## Verification

`npm run test:usage` runs offline policy/error tests.
`npm run test:usage:postgres` creates a randomly named disposable database using
local Compose credentials, applies all migrations, verifies real atomic SQL with
mock providers, then removes only that database. It refuses non-local/non-Compose
configuration and never modifies `lain_dev`. No test makes billable requests.
