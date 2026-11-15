# Netlify production readiness — Milestone 6E

Reviewed 15 November 2026. Target: GitHub → Netlify/OpenNext → Neon PostgreSQL,
with server-side OpenAI. **No deployment or billable request was performed.**
Public production voice remains disabled. This is preparation, not deployment
security approval; hosted adapter/Neon verification below remains a release blocker.
Milestone 6E.1 subsequently validated the user-built production artifact locally.

## Changes

- `netlify.toml`: npm production build, `.next` output, Node 24, esbuild for
  the explicit scheduled-functions directory. Use Netlify's automatic OpenNext
  installation; do not add legacy runtime configuration or static SPA rewrites.
- `@netlify/functions@6.1.1`: the official SDK supplies request-local identity.
  `USAGE_TRUSTED_PROXY=netlify` obtains **only** `getContext().ip`. Missing SDK
  context, malformed IP or missing HMAC key fails closed. Caller-supplied
  `X-Forwarded-For`, `x-nf-client-connection-ip` and Vercel headers are ignored in
  this mode. No spoofable environment marker is sufficient to establish identity.
  Daily HMAC digests and normalization are unchanged. The legacy Vercel mode is
  retained for compatibility, but is not the approved deployment configuration.
- Native scheduled cleanup shares the existing SQL maintenance implementation.
  A credential-free connection factory and transaction-lock helper let it run in
  ordinary Node without Next's `server-only` import condition. Application access
  stays behind `src/server/db/index.ts`'s server-only, lazy cache. Nothing connects
  at import time. No client imports these database modules.
- Runtime Neon pooler URLs omit unsupported startup timeout settings and verify
  bounded database-role defaults before releasing a new connection to queries.
  Local/direct PostgreSQL retains the existing startup timeouts. Drizzle accepts
  `DATABASE_MIGRATION_URL`, falling back to `DATABASE_URL` for local development.
- Audio SSE responses now specify `no-store, no-transform`, matching text SSE.
  There are no event, PCM, preset, shader, UI or schema changes.
- `bundles:measure` reports raw/gzip totals and the ten largest emitted JS/CSS
  files only after a successful build. These are aggregate assets, **not** a
  per-route first-load measurement. It refuses failed/partial build artifacts.

## Compatibility: documented versus verified

[Netlify's Next.js documentation](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/)
currently lists App Router, Route Handlers, response streaming, Turbopack and Cache
Components support. The published adapter inspected was `@netlify/plugin-nextjs`
5.16.7. The application uses Next 16.4.5. Automatic adapter updates are recommended;
record the actual adapter version in the eventual hosted build log. No adapter
packaging or hosted compatibility run completed here. Partial prefetching and the
exact framework/adapter combination need that run.

The [Functions API](https://docs.netlify.com/build/functions/api/) documents a
60-second streaming execution window and a 20 MB streamed response limit. Both
application streams are Web `Response`/`ReadableStream` SSE, not WebSocket upgrades:

| Path | Existing implementation and bounds | Local evidence / hosted work |
| --- | --- | --- |
| `/api/chat/stream` | metadata/delta/done/error, 25s request deadline; provider 20s; text output 16,000 UTF-8 bytes | Mock contract, cancellation, persistence and failure tests pass. Verify CDN flush timing and disconnect propagation. |
| `/api/voice`, development lab endpoint | PCM16 mono 24kHz **base64 inside audio SSE events**, not a raw binary audio response; 30s generation and 2.88MB raw audio budget per utterance; at most 800 characters and three segments | Mock event ordering/playback/cancellation tests pass. Base64 is approximately 3.84MB plus event framing at the full raw limit. Check actual transport framing/flush timing in isolated hosting. Production endpoints remain 404. |

The voice server makes an **outbound** OpenAI Realtime WebSocket connection; the
browser uses HTTP fetch and never requests microphone access. The provider socket
is closed on completion, timeout or handled cancellation, including late connects.
The source uses no persistent socket server, reconnect loop or background speech
job. Browser CSP `connect-src 'self'` does not restrict a Node server's outbound
socket. Actual Netlify outbound socket access, SDK packaging, close timing and
proxy disconnect propagation are **unverified**, not assumed from local tests.

DB operations have 5s statement/3s lock/8s client query bounds; admission and final
persistence add latency to generation. The 25s/30s generation deadlines alone do
not guarantee total invocation time below 60s during DB degradation. Observe
end-to-end duration and cancellation on the selected region/plan before release.
There is no `maxDuration` fiction or attempt to raise the platform's limits.
Abrupt runtime termination may lose partial assistant text; it cannot erase the
committed conservative cost reservation. No durable post-disconnect execution is
claimed. Existing stale-claim recovery still applies after 60s.

The documented [request context](https://docs.netlify.com/build/functions/api/#getcontext)
is the identity boundary. Hosted validation must prove that OpenNext preserves
this SDK context through Next handlers and asynchronous DB admission. If it does
not, API admission returns 503; **do not fall back to forwarded headers**. Test
forged IP headers, concurrent sessions, IPv4/IPv6 and direct function URLs. Additional
proxies must not bypass Netlify ingress; shared NATs share quotas and rotating IPs
remain an anonymous-abuse limitation.

## Neon setup and migration procedure

Use a dedicated production database/branch, not `lain_dev`, and separate isolated
branches for previews/tests. Place Netlify functions near Neon; verify the actual
Netlify region in its dashboard rather than assuming a default. Runtime `pg` pools
remain lazy, at most five connections **per function instance**, with 30s idle
expiry and 5s connection timeout. Instance counts multiply connections; monitor
Neon pool utilization and cold-start latency.

[Neon transaction pooling](https://neon.com/docs/connect/connection-pooling) does
not preserve arbitrary session settings. Before using a `-pooler` runtime hostname,
set role defaults through a **direct** connection (replace the role name):

```sql
ALTER ROLE lain_app SET statement_timeout = '5s';
ALTER ROLE lain_app SET lock_timeout = '3s';
-- Recommended protection against frozen clients leaving idle transactions:
ALTER ROLE lain_app SET idle_in_transaction_session_timeout = '10s';
```

Recycle existing pooler/server connections after changing defaults; existing
backends may retain old settings. The connection preflight requires positive
`statement_timeout <= 5000ms` and `lock_timeout <= 3000ms`, failing closed otherwise.
The checks were subsequently verified on real Neon staging in
[Milestone 7A](neon-onboarding-7a.md): pooled role propagation and external TLS
passed through the existing application client. Hosted Netlify integration still
requires validation. Transaction-local limits/advisory locks are
compatible with transaction pooling; the application does not use session locks
or named prepared statements. Do not disable certificate verification; obtain the
Neon URL with verified TLS, e.g. `sslmode=verify-full`.

From a trusted operator environment, using the intended direct migration role:

```sh
npm ci
npm run db:migrate
```

Provide `DATABASE_MIGRATION_URL` privately. Review committed SQL, backup/PITR and
target identity first; do not run migrations in builds or application startup.
The runtime role needs application DML, not schema ownership. Keep migration
credentials out of Netlify Functions. All existing migrations were exercised only
in disposable local databases during this task; no production or `lain_dev`
migration was applied.

## Netlify environment and GitHub setup (not executed)

Connect the reviewed GitHub repository/branch only when deployment is approved.
Build command/publish directory are in `netlify.toml`; no credentials belong in
that file. Pin the lockfile and use npm. Node 24 is selected; the SDK requires at
least 22.12. Verify the generated function runtime is Node 24. If necessary set
`AWS_LAMBDA_JS_RUNTIME=nodejs24.x` through Netlify UI/API, not TOML, per the
[runtime documentation](https://docs.netlify.com/build/functions/configuration/).

Configure these via Netlify UI/API with **Functions** scope (or all scopes where
scoping is unavailable), production deploy context only:

| Variable | Production configuration |
| --- | --- |
| `DATABASE_URL` | Verified-TLS Neon pooled URL for the restricted app role, after role setup above. |
| `OPENAI_API_KEY` | Server-only project key. Never `NEXT_PUBLIC_`, committed, browser-provided, or logged. |
| `OPENAI_MODEL`, `LAIN_AI_MODE` | Explicit model and `openai`; production mocks are rejected. Do not enable paid smoke tests without approval. |
| `USAGE_TRUSTED_PROXY`, `USAGE_IP_HMAC_KEY` | `netlify`, and a privately generated random key of at least 32 characters. |
| `USAGE_TEXT_*_USD_PER_MILLION` | Verified current input/output/cached prices for that model. Missing pricing fails closed. |
| `USAGE_*`, `API_*`, `STORAGE_*` | Conservative existing defaults in `.env.example`; review any override. Daily shared budget defaults to $1, session/global concurrency 2/4. |
| `SESSION_EXPIRED_RETENTION_DAYS`, `API_CLEANUP_BATCH` | Defaults 7 days after expiry, 100 direct mutations per invocation. |
| `SESSION_CLEANUP_APPLY` | `false` until retention/target are reviewed and approved; `true` opts into permanent cleanup. |

`DATABASE_MIGRATION_URL` is operator/CI-only. Do not give untrusted GitHub PR builds
production secrets or database access. Deploy Previews are production-mode builds:
mock mode and all voice endpoints stay unavailable. Netlify TOML build environment
variables are **not** Functions runtime variables; see
[environment scope documentation](https://docs.netlify.com/build/functions/environment-variables/).
Use the intended OpenAI project/key and direct API endpoint; do not assume an
implicit hosting AI gateway shares this application's pricing/accounting model.

## Scheduled retention

`netlify/functions/session-cleanup.mts` runs every 15 minutes UTC, for published
deploys only. [Scheduled Functions](https://docs.netlify.com/build/functions/scheduled-functions/)
have a 30s limit and are not callable by public URL. There is no cleanup HTTP route
or public cron secret. Netlify's dashboard can invoke them manually.

The default dry-run only checks eligibility. Apply mode reuses the bounded,
transactional cleanup: one expired-session candidate per run, grace period honored,
at most 100 direct mutations, at most 25 expired counter removals. Small claim-row
cascades are documented in the 6B.1 report. Billing records are detached, not erased.
Cleanup statement time is capped at 1s to bound work within the scheduled window;
a timeout rolls back the batch. The pool closes in `finally` even on failure.
Logs expose only a fixed error; no token, IP, URL, content or credentials.

At the default schedule, maintenance capacity is deliberately limited: at most
96 eligible-session candidates/day, possibly fewer when large sessions take
multiple batches. Expired counters share that mutation budget. Monitor backlog
and scheduler errors; adjust frequency/batch only after measurement. Billing-ledger
retention/global disk limits remain separate work. Scheduling is prepared but has
not run on Netlify and **no existing user data was deleted**.

## Security and persistent accounting

Production header tests verify same-origin CSP connections, no `unsafe-eval`,
no frames/objects/base URI, restrictive permissions, nosniff, no-referrer and HSTS.
Inline script/style allowances remain necessary for the current cached Next
bootstrap/R3F layout; this is not a strict nonce CSP. The approved WebGL/Web Audio
implementation needs no extra origins, microphone or worker permission. Hosted
HTML, static assets and error responses still need header verification.

Cookie tests verify production `__Host-lain_session`, HttpOnly, Secure, SameSite
Lax, Path `/`, no Domain, and persisted 30-day expiry. Requests use matching Origin;
ownership remains SQL-enforced. Keys stay behind server-only adapters and runtime
env. The development lab and voice APIs remain server-gated; production mock
configuration is rejected. Production client bundle secret scanning could not run
without a build. Never ship real credentials as build-time/public variables.

PostgreSQL tests confirm the shared transaction advisory lock, atomic quotas,
duplicate prevention, concurrency, reserve-before-dispatch, budget reconciliation,
and conservative interrupted charging. Netlify IP guards cover both paid and
non-billable admission; session rotation cannot reset that IP bucket. Each speech
segment still consumes a reservation and the cumulative character/segment budget.
DB/accounting failure never falls back to memory or permits an unaccounted call.
Global spend is admission-day based, estimated in integer micro-USD, not a hard
provider invoice cap. Unknown usage stays charged at its reservation; actual
pricing/token categories must remain current. Keep provider-side project budgets,
alerts, trusted-ingress body/request controls and monitoring in addition to app
limits. Multi-IP abuse, billing-ledger growth and ownership-bound speech narration
remain in the security reports; production voice stays off.

## Validation and outstanding release gates

- Lint passed. Typecheck passed after correcting the new fixture's environment
  type; the affected check was rerun.
- Regression: 102 server/chat/security + 8 UI tests passed. Cloud voice: 39 mocked
  tests passed; existing focused usage 4 and abuse 3 passed.
- New Netlify tests: 4 passed, including SDK async context isolation, forged-header
  rejection, lazy connection/preflight checks and the scheduled entry point under
  **ordinary Node conditions** (no Next server-only condition required).
- Disposable PostgreSQL: 16 usage and 8 abuse/retention test results passed
  (including their parent tests). New cases verify Netlify identity across cookie
  rotation. Both temporary databases were removed. `lain_dev` was not mutated.
- Production dependency audit: zero findings; full install still reports the 11
  previously reviewed moderate development-tooling findings. Four Netlify SDK
  packages were added; no unrelated lockfile upgrades.
- Original sandbox production build failed in Turbopack CSS processing: creating
  new process → binding to a port → `Operation not permitted (os error 1)`.
  [Original build log](netlify-6e-build-error.txt) is retained as historical evidence.
  **Superseded by the successful user build and artifact validation below.**

## Milestone 6E.1 — confirmed production artifact validation

The user reports `npm run build` completed compilation, TypeScript checking and
static generation outside the sandbox. No rebuild was performed for this review.
The existing artifact has build ID `ReOCvKNDh1uMGnU2affYX`; local `next start`
served it successfully. This confirms the earlier port-binding failure was an
execution-environment restriction, rather than a demonstrated application build
failure. It does not validate Netlify's adapter packaging.

Measured with the existing `npm run bundles:measure` tooling:

| Emitted asset group | Files | Raw bytes | Gzip bytes |
| --- | ---: | ---: | ---: |
| JavaScript | 14 | 1,828,871 | 525,358 |
| CSS | 2 | 33,739 | 7,921 |

These are totals across all emitted static chunks, including lazy/development
routes, not initial-page sizes. The largest orb/Three.js-related chunk is
930,895 bytes raw / 245,625 gzip. The focused browser measured eight JS resources
on the welcome screen after the orb became ready: 1,620,626 decoded bytes and
456,116 transfer bytes on a fresh local browser profile. Restoring a synthetic
conversation loaded one additional 68,938-byte JS chunk (22,634 transferred) for
highlighting. These are local HTTP observations, not Netlify CDN or first-paint
measurements.

### Bundle inspection

Scanned 17 static assets, 20 rendered HTML/RSC/text artifacts and 243 server
bundle/map/manifest files, including required-server configuration. Configured
OpenAI key and DATABASE_URL values were compared **in memory**, without printing
values; neither appeared. Additional key-shaped literals and credential-bearing
PostgreSQL URL patterns found no matches. No client key/environment names, DB
admission SQL or canonical personality text were found in public assets. No
public source maps, local model weights/WASM, HMR endpoint marker or development
overlay marker were found. This is a bounded scan, not proof against every possible
secret encoding or an attestation of the whole dependency supply chain.

One unnecessary development asset remains emitted:
`/_next/static/chunks/15w9bk1ei40nz.js` contains the cloud voice lab UI,
26,318 bytes raw / 9,397 gzip. It is directly retrievable as a static JS file
(200), although the page and provider route are blocked. Neither tested main-app
state requested this chunk. Its Kokoro string is disclosure text saying that no
model is downloaded, not a restored local inference pipeline. No secrets or
billable capability were found in it. Excluding this lab-only bundle is an
optional future build cleanup, not a reason to modify/rebuild the approved
artifact during this validation. Do not equate a route 404 with removal of all
associated static client code.

### Production route and CSP checks

Started the artifact on loopback port 3161 with OpenAI/database/migration/HMAC
credentials cleared and no mock mode enabled. Direct HTTP results:

| Request | Result |
| --- | --- |
| `GET /` | 200 |
| `GET /dev/cloud-voice` | 404 |
| `POST /api/dev/cloud-voice` | 404, safe `NOT_FOUND` JSON |
| `POST /api/voice` | 404, safe `NOT_FOUND` JSON |
| `GET /.env` | 404 |
| `GET /_next/server/app/api/voice/route.js` | 404 |

The actual document/404/API responses carry the production CSP, HSTS and nosniff
headers. Voice responses retain `no-store, no-transform`. Production voice was
never enabled, and no generation was requested from a provider.

One focused Chromium 158 workflow checked the welcome screen and restored
conversation at 1440×900. The real approved orb rendered/animated under the
**shipped production CSP**, using ANGLE/Vulkan on an NVIDIA GTX 1660 SUPER.
The welcome text, composer, two message rows, highlighted code block and table
rendered; there was no horizontal overflow. Recorded CSP violations: **0**;
JavaScript/console errors: **0**; external network requests: **0**. A screenshot
was visually inspected. No CSP or application source changes were necessary.

Session/history API responses were intercepted solely in the browser using
synthetic fixtures before hydration (three requests). No runtime security guard
or production mock-provider gate was weakened. This proves rendering of restored
message fixtures, not real session/DB restoration, live text/audio streaming,
HTTPS cookie delivery or audio playback. The latter remains unavailable in the
production UI by design. The local production server/browser were stopped after
verification. No billable calls, database mutations or deployment occurred.

Raw measurements, safe scan results and response headers are in
[the validation artifact](production-artifact-6e1.json). Changes for 6E.1 are
limited to this report and that JSON evidence file. No lint/typecheck/regression
rerun was needed for documentation-only changes; the earlier 6E results above
remain distinct from these focused artifact/HTTP/browser checks.

### Remaining release blockers

The local production build, bundle measurement, public-asset inspection,
development-route restrictions and orb/interface CSP checks are now confirmed.
The remaining release gates require an approved protected Netlify staging run:

- Actual OpenNext packaging and SDK request-context propagation through Next/DB
  calls; verify fail-closed behavior and forged-IP rejection at hosted ingress.
- Neon staging TLS, role-default propagation, migration history and role privileges
  passed in [Milestone 7A](neon-onboarding-7a.md). Production remains unmigrated;
  hosted Netlify ownership/usage tests and region alignment still require validation.
- CDN SSE flushing and cancellation/disconnect propagation; outbound Realtime
  socket packaging/cleanup and total function duration under DB degradation.
  Use a separate synthetic SSE/PCM fixture for non-billable transport checks.
- Hosted HTTPS cookie/header/error-response behavior, scheduled dry-run execution,
  monitoring/alerts, ingress controls and retention opt-in review.

Do not enable production mocks or voice to test these items. Any end-to-end OpenAI
verification still needs separate billable approval. Ownership-bound speech
narration remains a blocker for a future public voice release. The 11 previously
reviewed moderate development-tooling advisories remain documented; no new audit
was performed in this artifact-only task. Nothing has been deployed.

## Rollback

Keep the last approved deploy ID/commit, adapter version, environment snapshot and
Neon recovery point. For code rollback, publish the previous known-good Netlify
deploy only after approval and confirm schema compatibility. This milestone adds
no schema migration. Do not roll back/drop/reset the usage ledger to undo a code
deploy: that could erase spend and idempotency records. Prefer forward-compatible
migrations; restore database backups only as an explicit incident operation.

In an incident, first stop traffic or revoke the OpenAI project key to stop spend.
Set cleanup apply false and review quotas/config before rebuilding. Netlify env
changes require a new deploy; a rollback can restore the older deploy's settings,
so inspect them rather than assuming current dashboard values apply. Keep voice
404s in place, recheck guards and headers, then resume traffic after verification.
