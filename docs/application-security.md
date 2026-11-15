# Application security review — Milestone 6B

Reviewed 15 November 2026. Scope: current source, API/session/persistence handlers,
usage ledger, browser rendering, runtime configuration and focused regression
coverage. This is not a penetration test, infrastructure assessment, secret-history
scan or authorization to deploy. Public production voice remains disabled.

## Confirmed gaps and fixes

1. **Missing browser security headers** (defense-in-depth gap). There was no
   application-wide protection against framing, MIME sniffing, referrer leakage,
   or unintended resource origins. `next.config.ts` now sets an enforced CSP,
   `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
   `Referrer-Policy: no-referrer`, and disables camera/microphone/geolocation via
   Permissions Policy. Production adds one-year HSTS without subdomain/preload
   assumptions. Next's powered-by header is disabled. Headers cover pages and APIs.
2. **Unbounded ordinary database queries** (availability gap). Connection creation
   had a timeout, and usage/persistence transactions set local SQL limits, but
   ordinary session/history queries could hold the small pool indefinitely on
   blocked SQL or stalled reads. The lazy application pool now defaults to 5s SQL
   statement, 3s lock, and 8s client read timeouts. Existing transaction-specific
   bounds still apply. No schema change or startup connection was introduced.
   A disposable PostgreSQL test verifies settings, forced query cancellation and
   recovery. SQL/network timeouts do not guarantee whole-transaction completion
   during process termination or a network partition.

## Reviewed boundaries

| Area | Verified implementation / qualification |
| --- | --- |
| Secrets | OpenAI keys, DATABASE_URL and IP-HMAC key are read only in `server-only` modules. No NEXT_PUBLIC secrets or literal OpenAI keys were found in inspected source/docs. Only `.env.example` is tracked among environment files; real environment files remain ignored. This does not certify repository history or external logs. |
| Anonymous sessions | 32 random bytes from Node crypto; only SHA-256 hashes persist. Tokens must be 64 lowercase hex characters before lookup. Safe session metadata excludes hashes/tokens. Production uses a Secure, HttpOnly, SameSite=Lax, Path=/, no-Domain `__Host-` cookie with explicit database-matching expiry. |
| Expiry / rotation | 30-day absolute lifetime. Valid tokens reuse the record without writes. Missing, malformed, unknown or expired tokens get fresh sessions only through POST /api/session. No privilege escalation/authentication lifecycle exists. No periodic token rotation, revocation endpoint, account recovery or expired-session sweeper is implemented. |
| Ownership | Conversation reads/writes constrain session ownership in SQL. Message access joins or checks the owning conversation. UUID knowledge alone grants nothing. Missing/foreign lookups return the same safe 404. Deletion races cannot recreate a conversation during late stream finalization. |
| SQL injection | Validated UUIDs/enums/titles/messages go through parameterized Drizzle expressions. No client-derived raw SQL interpolation was found. Fixed SQL fragments and test-only random database names are not user input. |
| XSS / Markdown | React renders user text literally. Assistant rendering disables raw HTML, retains react-markdown's safe URL transform, replaces remote images with text, and uses escaped code/highlight spans. External links use noopener/noreferrer. Copy controls do not execute snippets. Model-generated links/text remain untrusted. |
| CSRF | State-changing session/conversation/persisted/paid routes require exact matching Origin; cross-site Fetch Metadata is rejected. JSON routes reject other media/compression and no permissive CORS exists. Legacy free mock/ephemeral validation can omit Origin, but real paid calls cannot. GET ownership routes are read-only and return no-store JSON. |
| Validation / deadlines | Actual streamed bytes are bounded, not just Content-Length: 32 KiB chat/voice bodies; 20 messages, 4,000 characters/message, 12,000 combined; 2 KiB title bodies and bounded pagination. Chat has a 25s deadline/20s SDK timeout, speech 30s cumulative upstream and 60s PCM budgets. Providers have no automatic paid retries. |
| Usage / concurrency | PostgreSQL admission lock serializes quota, daily shared budget and concurrency checks. Unique session/kind/request/segment reservations and one-time dispatch prevent concurrent duplicate calls. Persisted claim/reservation share a transaction. Completed replay does not regenerate. DB/accounting failure blocks new paid work and prevents successful completion acknowledgement. |
| Budget accuracy | UTF-8 input bytes plus overhead and provider output caps reserve estimated maxima at snapshotted prices. Final usage reconciles; unknown/interrupted spend keeps the maximum. Unstarted expired reservations can be voided safely; started crashed claims retain charges. Operator tariff errors, unknown usage and provider timing prevent an invoice-cap guarantee. See usage-protection documentation. |
| IP trust / rotation | Netlify uses only the official Functions request-context IP; absent context fails closed. The legacy Vercel mode remains for compatibility. Other forwarded headers are ignored; missing/malformed trusted addresses fail closed. Daily keyed IP hashes survive cookie/session rotation without storing raw addresses. Production paid requests fail closed without supported trusted-ingress configuration. |
| Speech authorization | Main speech requires an existing valid session, same-origin POST, server-approved model/voice/delivery, admission and per-sequence limits. Every segment counts; at most three ordered segments and 800 combined characters. Lab delivery is editable only in the development lab. Client request IDs cannot bypass persistent quotas. |
| Development isolation | Mock adapters fail outside development. Both speech endpoints and the remaining lab page return 404 outside development. Client activation also refuses production. No removed local model/worker is initialized. Development servers must never be publicly deployed. |
| Logs / errors | Database logging is off; idle pool errors use a constant message. OpenAI text SDK logging is off. Handler error responses are sanitized, do not serialize provider/SQL exceptions, and never include credentials or full conversation logs. Platform/access logs are outside this source audit. |

## CSP compatibility and limits

The enforced baseline permits only same-origin connections/scripts/fonts,
self/blob media, and self/blob/data images; objects, workers, base tags and framing
are prohibited. Production does not allow JavaScript eval. Development allows eval
and WebSockets for Next debugging/HMR. WebGL shader compilation and PCM/Web Audio
need neither microphone access nor direct browser connections to OpenAI.

Next's current cache-components/static bootstrap requires inline scripts, and R3F
canvas sizing/UI controls use inline styles, so both remain allowed. **This is not
a strict nonce/hash CSP and does not block arbitrary injected inline JavaScript.**
HTML/URL sanitization remains essential. Switching to a strict CSP requires a
separately tested rendering/build strategy, not an untested nonce bolted onto
cached HTML. The [Next CSP guide](https://nextjs.org/docs/app/guides/content-security-policy)
explains nonce-dependent dynamic rendering. No cache/layout architecture was
changed. Header tests verify production/development directives; a real production
artifact and its actual host/proxy still need browser compatibility verification.

## Residual risks and deployment requirements

- **Anonymous abuse is not solved by CSRF or session quotas.** Non-browser clients
  can set Origin and create new sessions. IP limits plus the global cost budget
  constrain paid use. [Milestone 6B.1](non-billable-abuse-protection.md) added
  persistent guards/storage caps for session and conversation APIs; rejected
  ingress traffic still needs trusted-edge limits. Before public deployment,
  configure ingress body/connection bounds and review scheduled retention.
  Do not infer public readiness from successful paid-usage tests.
- Trust only the actual hosting platform's overwritten address headers, reject
  unexpected Host/forwarded-host values at ingress, and prevent direct-origin
  bypass. Netlify uses `@netlify/functions` request context instead of forwarded headers; see [Milestone 6E](netlify-production-6e.md) for hosted verification requirements. Shared NATs share quotas; changing
  IP/IPv6 addresses can evade per-IP quotas. Daily HMAC rotation resets IP windows
  at UTC midnight. Global reservations remain the final application spend guard.
- Speech accepts bounded caller-supplied narration for a verified anonymous
  session; it does **not** prove that the text came from a particular persisted
  assistant message. Progressive deltas are not yet durable text. Public voice
  stays off; ownership-bound narration authorization needs design/validation
  before any future public voice rollout. Model prompt compliance is not an
  authorization mechanism. No API/preset/playback behavior was changed here.
- Use HTTPS only, configure HTTP→HTTPS at ingress, verify secure host-cookie
  delivery and preserve the security headers on CDN/error responses. Configure
  database TLS certificate verification and a least-privilege application role;
  the local Compose owner credential is not the production deployment design.
  Audit DATABASE_URL query parameters because pg URL options can override pool
  defaults. Keep migrations explicit and separate from runtime credentials.
- Confirm current tariffs for the selected model; set conservative quotas/budget
  and provider project spending controls. Allow server execution time for
  cancellation and final database accounting. Do not prune live idempotency/budget
  windows. There is no crash-proof persistence of uncommitted assistant deltas.
- The anonymous cookie is a bearer credential. Its theft permits session access
  until expiry; no account-based recovery or revocation UI exists. Local recovery
  records may contain conversation text and are readable by same-origin scripts.
  Set a privacy/retention policy for database, backups and platform logs. Never log
  Cookie/Authorization headers, prompts, responses or raw IPs in added telemetry.
- Eleven moderate development dependency findings remain as documented in
  [6A](dependency-security.md). Exclude development tooling from the runtime image
  where supported and revisit compatible upstream fixes. No dependency was added.

Session/CSRF review used the [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
and [origin/Fetch Metadata guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
as references; conclusions above are based on this repository's implementation.

## Validation

The regression suite includes new security-header checks and pool timeout
assertions alongside existing session, ownership, CSRF, XSS, validation, safe-error,
stream cancellation and production-mock tests. Focused cloud and usage tests use
mock providers. Live PostgreSQL checks create/migrate/remove only independently
named disposable databases, never reset or mutate `lain_dev`. Final results follow.

- Lint and typecheck passed once.
- Regression suite passed: 102 server/chat/security tests plus 7 rendering tests.
- Focused cloud voice: 39 passed; usage policy/error handling: 4 passed.
- Disposable PostgreSQL usage suite: 14 cases passed (15 including parent), with
  query/lock timeout settings and cancellation/recovery added in this milestone.
- Disposable PostgreSQL sessions: 7 cases passed (8 including parent).
- Disposable PostgreSQL conversation management: 7 cases passed (8 including parent),
  including cross-session rejection and finalization/deletion races.
- All three disposable databases were removed. `lain_dev` was not mutated and
  no billable provider calls or production builds were made.
- CSP configuration tests are not a real production-browser/hosting verification;
  no production artifact or public deployment was exercised during this review.

## Milestone 6B.1 follow-up

[Non-billable protection](non-billable-abuse-protection.md) adds persistent fixed-
window IP/session guards for session and conversation APIs, atomic per-session
conversation/message caps, and an explicit dry-run-first bounded retention tool.
This supersedes the missing application caps/cleanup described above. No existing
user data is deleted automatically; ingress flood protection, global disk capacity,
operator-run maintenance and the other deployment requirements remain relevant.
