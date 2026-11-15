# Non-billable API protection — Milestone 6B.1

The existing PostgreSQL usage admission infrastructure now also protects session
initialization and conversation create/list/get/rename/delete. There are no new
services or dependencies. Production voice stays disabled. Apply reviewed
`0003_fuzzy_elektra.sql` explicitly with `npm run db:migrate` before using the new
guards. No migrations or cleanup run at application startup.

## Request admission

`src/server/abuse/guard.ts` reuses the existing PostgreSQL transaction advisory lock,
query bounds, safe UsageError responses and trusted-IP HMAC implementation.
A short IP-only admission transaction runs **before** session lookup/creation.
A second session-only admission follows verified identity. No transaction/pool
connection is held while doing the cookie lookup, avoiding pool exhaustion through
nested admission lookups. Bad/expired/missing cookies still consume IP allowance;
changing cookies or creating new sessions does not reset that allowance.
Cross-origin state-changing requests are rejected before database work.

The one new table, `api_rate_buckets`, stores an opaque key, integer count and
expiry, not request logs. A fixed-minute and UTC-day counter are upserted for each
scope, with conditional updates below the configured limit. Exceeding either
window rolls back that scope's transaction. Accepted IP admissions remain counted
if later validation/session/storage work fails. Rejected admissions allocate no
new buckets. Counter keys never include raw IPs, tokens, text or URL query data.
There are at most two counter updates per scope; admission uses primary-key
lookups, not scans of the billing ledger or one new row per request. New minutes
can allocate new counters; old counters expire two UTC midnights after their day
and are removed only by explicit bounded maintenance.

| Endpoint category | IP minute/day | Session minute/day |
| --- | --- | --- |
| `session`: POST /api/session, including valid-session reuse | 20 / 200 | 20 / 200 |
| `create`: POST /api/conversations | 10 / 100 | 5 / 50 |
| `read`: GET collection and individual conversation | 120 / 2,000 | 60 / 1,000 |
| `mutate`: PATCH / DELETE individual conversation | 30 / 300 | 15 / 150 |

Every value is configurable as `API_<CATEGORY>_<IP|SESSION>_<MINUTE|DAY>`;
all defaults appear in `.env.example`. Integers 0–100,000 are allowed; zero denies
that class of request. Rate-limit responses retain `{ok:false,error:{code,message}}`
with safe 429 `API_RATE_LIMIT` and Retry-After until the exceeded fixed window
ends. Database/configuration failure returns safe 503 and never falls back to an
in-memory limiter. Existing ownership, pagination, CSRF and no-store responses stay
in force. Successful session creation precedes its first session-only admission;
a later accounting failure can leave an orphan session without issuing a cookie,
but its prior IP admission remains charged.

IP trust reuses `USAGE_TRUSTED_PROXY=vercel`, genuine `VERCEL=1`, and a server-only
HMAC key of at least 32 characters. Only the platform-overwritten
`x-vercel-forwarded-for` is accepted; generic forwarded headers cannot change the
bucket. Production fails closed without this configuration. Local development
with `none` ignores address headers and shares a conservative `local` IP bucket.
Fixed windows permit a boundary burst (up to two minute allowances across a
minute boundary); UTC-day HMAC rotation also resets IP windows at midnight.

## Storage admission

- `STORAGE_CONVERSATIONS_PER_SESSION=50`.
- `STORAGE_MESSAGES_PER_SESSION=1000`, summed across all owned conversations,
  including completed/failed/interrupted/pending assistant placeholders.

Repository creation/appends hold the same transaction admission lock through
counting and insertion, preventing concurrent quota bypass. Stream claim creation
checks capacity for **both** user and assistant rows before billing admission or
writes; the entire claim rolls back if capacity is unavailable. Replay/finalization
updates existing rows and does not allocate additional storage slots. Existing
message length bounds remain, so count limits also bound new content growth
(up to roughly 64 MB of message UTF-8 text at 1,000 × 16,000 four-byte characters,
plus database/index overhead; normal user/streamed messages have tighter limits).
Counts use existing ownership indexes and are bounded by configured storage caps
for new sessions. Do not increase these caps without load testing.

The safe 429 `STORAGE_LIMIT` response suggests deleting old conversations; there
is no misleading Retry-After because space does not refill on a clock. Rename,
delete and completion remain available at the cap. Lowering caps below existing
usage does not remove data; only further inserts are rejected. Internal writes
outside these repositories are trusted administrative operations, not guarded APIs.

## Expired-session retention and explicit maintenance

The anonymous lifetime remains 30 days. After expiry, data is retained for another
`SESSION_EXPIRED_RETENTION_DAYS=7` days (configurable 0–365). Only sessions strictly
older than this grace cutoff are eligible. Active and grace-period sessions are
never removed by this mechanism. Expired tokens cannot access data during grace;
this is retention, not an extension of credential validity.

```bash
npm run sessions:cleanup          # Dry-run by default; reports bounded eligibility
# Only after reviewing the target and explicitly authorizing permanent deletion:
npm run sessions:cleanup -- --apply
```

**Do not run --apply against existing user data without a separate, deliberate
operator decision.** This milestone's verification applies cleanup only to fresh
disposable test fixtures; it does not delete development/user data.

`API_CLEANUP_BATCH=100` (1–1,000) bounds directly deleted/updated rows per invocation.
Each invocation considers at most one expired session. It prunes at most 25 expired
rate buckets, then deletes that owner's messages in bounded batches, empty
conversations, detaches billing reservation/utterance references in bounded
batches, and deletes the session only when all children/references are gone.
Foreign-key message cascades may additionally remove up to two uniquely linked
stream-request rows per deleted message. Parent/session deletion cannot trigger
an unbounded cascade over old oversized conversations or billing records.
Repeated explicit runs advance a large session over multiple batches. Tiny batch
sizes can devote all work to expired counters; use the default or larger batch
when processing a backlog. A dry run does not perform cleanup or count entire
large tables; eligibility is capped at one, not a total backlog estimate.

Current billing spend/idempotency records are **not deleted**: references become
null only after the owning session is past grace. Costs/IP digests remain intact.
Counters stay independent of session rows, so cleanup/rotation cannot erase live
IP allowances. The existing SQL lock/statement/read deadlines apply. A failed
batch rolls back; process termination before commit makes no partial batch durable.
This is a row-bounded maintenance tool, not an automatic scheduler or a promise of
instant removal from backups/platform logs.

## Validation and remaining risks

`npm run test:abuse` covers policy, pre-lookup denial, Retry-After, error sanitation
and pagination/identity flow with isolated fixtures. `npm run test:abuse:postgres`
creates a designated disposable local database, applies migrations, verifies real
concurrent admission/storage limits and dry-run/bounded retention, then removes
only that database. No provider calls occur. Existing regression and usage tests
remain necessary; no `lain_dev` mutation is part of these checks.

Application admission still requires a database transaction for each scope;
resource exhaustion *before* reaching the guard needs trusted-ingress connection,
body-size and request-rate limits. Rejected/CSRF requests still cost network/CPU.
NAT users share IP limits; attackers with many IP/IPv6 addresses can create many
bounded sessions. These are per-session caps, not a global disk ceiling. Monitor
capacity and set trusted-edge/global admission policy before a public rollout.
Cleanup must be invoked by an operator: counter/expired-session storage continues
to accumulate if maintenance is never run. Billing-ledger retention is a separate
future policy. DB backups may retain deleted records. The shared admission lock
favours correctness over very high throughput and needs load testing on the real
host. All other [6B deployment requirements](application-security.md) still apply.

## Completed validation

- Lint passed; an unused fixture import warning was corrected and its affected
  files rechecked. Typecheck passed after correcting new fixture types.
- Existing regression suite: 102 server/chat/security and 7 rendering tests passed.
- Focused non-billable guard tests: 3 passed; existing usage tests: 4 passed;
  cloud-voice mock tests: 39 passed, including production isolation.
- Disposable PostgreSQL: 6 non-billable/storage/cleanup cases, 14 existing usage
  cases, 7 session cases and 7 conversation-management cases passed. All four
  test databases were removed; no existing database/data was reset or deleted.
- The migration was generated offline and applied only to disposable test DBs.
  `lain_dev` was not mutated. No billable calls or production builds were made.
