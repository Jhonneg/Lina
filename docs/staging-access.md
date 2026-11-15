# Temporary staging access protection

This is a temporary shared operator gate, not user-account authentication. The
interface/orb stay public. Anonymous sessions, SQL ownership checks, paid usage
accounting, cancellation and production voice restrictions remain in force.
Nothing in this task was deployed or configured with real credentials.

## Required server configuration

| Variable | Value / purpose |
| --- | --- |
| `STAGING_ACCESS_MODE` | `restricted` for staging. Production defaults to restricted if unset; invalid values fail closed. Development/test defaults to disabled only when the variable is absent. |
| `STAGING_ACCESS_SECRET` | Exactly 64 hexadecimal characters generated from 32 cryptographically random bytes. Required in restricted mode; missing/malformed or single-character repeated values fail closed. Never use a human password. |
| `USAGE_TRUSTED_PROXY` | Existing `netlify` mode on Netlify. |
| `USAGE_IP_HMAC_KEY` | Existing independent server-only random key, at least 32 characters. Never reuse the access secret. |
| `DATABASE_URL` | Existing **staging**, pooled `lain_app` runtime connection, only after the gate is deployed and anonymous rejection verified. |
| `API_ACCESS_IP_MINUTE` | Optional login-attempt limit, default 5. |
| `API_ACCESS_IP_DAY` | Optional UTC-day login-attempt limit, default 30. |

Generate the staging secret privately with a password manager or
`openssl rand -hex 32`. Do not paste it in chat, source, URLs, command arguments,
logs or public variables. Store it in Netlify's Functions-scoped environment
settings for the staging project. Never use `NEXT_PUBLIC_`. Existing `.env` and
`.env.local` were not modified; `.env.example` documents variable names only.

The usual model/pricing/quota variables are still required for paid text calls.
This gate does not bypass their validation. Keep migration credentials outside
Netlify, `SESSION_CLEANUP_APPLY=false`, and public production voice disabled.

## Operator flow and cookie

Visit `/staging-access` over HTTPS and enter the secret in the password form.
`POST /api/staging-access` requires an explicit matching Origin, rejects cross-site
metadata, bounds the JSON body to 1 KiB and reading to 5s, and compares fixed-size
SHA-256 digests in constant time. Production login requires an HTTPS request URL.
Successful responses contain expiration metadata only, never credentials/tokens.

The eight-hour cookie is `__Host-lain_staging` in production: Secure, HttpOnly,
SameSite=Lax, Path `/`, no Domain, explicit Max-Age. Local HTTP development uses
`lain_staging` without Secure. Its value contains a version, issue time, random
nonce and domain-separated HMAC; it does not contain the access secret. Handlers
verify signature/format and expiry on each request. The cookie is not stored in
React, localStorage or sessionStorage. Entered password text exists transiently in
the login form and is cleared after an attempt; the app does not persist it.

`GET /api/staging-access` is a stateless, no-store availability/authorization
check; it neither creates sessions nor reads the database. `DELETE` requires same
origin and clears only the operator cookie. Sign out from `/staging-access`.
Rotating the server access secret invalidates all operator cookies after the new
configuration is active. Individual-token revocation is not implemented. Already
admitted, bounded streams can finish after cookie expiry/rotation; subsequent
requests are checked again.

## Enforcement and brute-force protection

Every existing session, conversation create/list/get/rename/delete, text chat,
text-stream, main voice and development voice handler checks the gate directly
as its first operation. It does not rely on the UI, Proxy/Middleware or a URL
allowlist. Visitors receive safe 401 JSON; invalid access configuration returns
503. No database, session-service or provider work is performed first. Authorized
operators still need their existing valid anonymous session and conversation
ownership; the shared operator credential does not prove ownership.

The **one intentional public database operation** is authentication admission:
well-formed login attempts use the existing PostgreSQL `api_rate_buckets` limiter
under the existing transaction lock, before comparing the credential. New `access`
counter keys need no schema migration. Counts are per trusted, daily-HMAC IP,
shared across processes/instances, independent of anonymous cookies. Invalid and
successful credential attempts both consume allowance. Exhaustion returns 429
with Retry-After; database/accounting/trusted-IP failure returns 503 and never
issues a cookie. Malformed/oversized bodies and CSRF failures never reach a
credential comparison. There is no in-memory rate-limit fallback.

The public status/login/logout routes are necessary authentication entry points,
not bypasses to conversational APIs. Netlify's scheduled cleanup remains a
separate scheduled-only, non-public HTTP function; its dry-run default is unchanged.
Future database/provider handlers must invoke the same gate before any work and
be included in the direct-handler regression coverage.

The client checks access before initializing an anonymous session or restoring a
conversation. Visitors retain the approved orb/welcome layout, see a concise
notice/operator link and cannot submit messages. History/voice actions do not
start database/provider work. The same canvas component stays mounted while the
access check resolves. API authorization remains authoritative if the UI is stale
or bypassed; expired access yields a safe error and can be renewed at the operator
page. No shader, geometry, animation, DSP or voice-preset changes were made.

## Safe rollout and disablement (not executed)

1. Review and deploy the guarded code **without database/OpenAI credentials**.
   Configure restricted mode and a privately generated secret for that deploy.
   Existing public deployments do not gain this protection until updated.
2. Verify unauthorized POST requests to chat/session/voice and all conversation
   routes return the staging denial before adding credentials. Check all site
   aliases and direct function URLs. Missing config should fail closed with 503.
3. Only then configure the staging pooled database, trusted-IP HMAC settings and
   existing quotas/pricing. Verify bad-login throttling and operator login. Do not
   automatically send a model request. Keep cleanup dry-run and voice unavailable.
4. Recheck hosted Netlify request-context propagation, secure cookie delivery,
   actual API gate behavior, cancellation and accounting. Local evidence is not
   proof that Netlify is configured correctly.

After explicit release/security approval, set `STAGING_ACCESS_MODE=disabled` and
redeploy to intentionally expose conversation endpoints under their existing
session/usage protections. In disabled mode the login POST returns 404. Do not
remove the secret while leaving restricted mode enabled: that intentionally
blocks conversation APIs. Do not roll back to an unguarded deployment while it
has database/provider credentials; stop traffic or revoke/remove those credentials
first, considering Netlify's per-deploy environment snapshots.

## Validation

- Lint passed after fixing the login page's Next navigation use; affected files
  were rechecked. Typecheck passed after preserving the session handler's
  NextResponse return type; the affected check was rerun.
- Six focused tests cover production defaults/missing config, explicit disablement,
  signed/expired/forged cookies, rotation, ten direct handler entry points before
  dependency access, authorized access, cookie flags, logout, invalid credentials,
  rate/database errors, HTTPS/CSRF protection and payload bounds.
- Existing regression suite: 102 server/chat/security tests and 9 rendering tests
  passed, including the new visitor notice/disabled-composer rendering assertion.
  Cloud-voice mock suite: 39 passed; existing focused API-guard tests: 3 passed.
- Disposable PostgreSQL suite: 9 test results passed (including its parent test).
  The new login case proves that bad attempts persist across independent handlers
  and rotated cookies, blocking even a subsequently correct secret when exhausted.
  The newly created test database was removed; `lain_dev` and Neon were untouched.
- One Chromium 158 workflow on an isolated **development** preview: visitor notice
  present, composer disabled, approved orb rendering, no visitor session/history
  requests. A test-only signed cookie enabled the existing restored-conversation
  UI with intercepted fixtures. Zero recorded errors/CSP violations. This was not
  a hosted/production authentication or real provider playback test. The preview
  used a non-deployment fixture secret and blank database/OpenAI configuration.
- No production build, deployment, real credential setup, dependency installation,
  database migration or billable request was performed. Preview processes stopped.

## Remaining limits

This shared-secret gate is temporary. It has no individual identities, MFA,
per-operator audit trail or durable token revocation list. A stolen cookie grants
operator admission until expiry/key rotation, while existing anonymous ownership
still applies. Protect the operator machine and secret, use HTTPS, and rotate the
secret if compromised. Multi-IP request floods and infrastructure/SQL admission
load still need ingress-level controls; app rate limits do not eliminate DDoS.
Production mode must remain the actual runtime mode. The live public deployment
is unchanged by this local implementation; it must not receive credentials until
the guarded deploy and anonymous-access checks are approved and completed.
