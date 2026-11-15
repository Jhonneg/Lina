# Neon onboarding — Milestone 7A

Validated 15 November 2026 through the authenticated, manually configured Neon
MCP server and the existing local `pg`/Drizzle packages. No marketplace discovery,
new dependencies, local database access, environment-file writes or deployment.

## Resources

- Project: **lina-ai** (`icy-bread-54397667`), renamed from `lain` at the user's request.
  The PostgreSQL database remains named `lain`; connection strings are unchanged.
- Organization: Jonee (`org-broad-fire-90541896`), confirmed **Free** before and
  after provisioning. No plan change was requested or made.
- PostgreSQL **17.12**, AWS Ohio (`aws-us-east-2`).
- Default/root branch: **production** (`br-tiny-queen-bejw2edf`).
- Child branch: **staging** (`br-still-term-bet45t03`), forked before migrations.
- Database: `lain`; database-owner/migration role: `lain_migrator`.
- Staging runtime role: `lain_app`, scoped read/write access to public tables;
  no superuser, role creation or public-schema CREATE privileges.
- Computes: fixed 0.25 CU, provider-default idle suspension; no always-on or paid
  compute configuration. Both branches report ready. Branch protection is false;
  no protection feature or plan upgrade was enabled.

Production remains intentionally **unmigrated**, with zero public application
tables and no Drizzle history table. Its database was inspected read-only.
No local conversation data was copied. Existing Neon projects were not modified.

## Migrations and validation

The installed Drizzle migration reader loaded the four existing SQL files,
SHA-256 hashes and journal timestamps. Exact SQL and matching Drizzle history
entries were applied through one MCP SQL transaction on **staging only**:

1. `0000_initial_database`
2. `0001_stream_request_idempotency`
3. `0002_sleepy_jane_foster`
4. `0003_fuzzy_elektra`

This initial application used MCP SQL, not `npm run db:migrate`. The installed
Drizzle migrator was then run over the staging **direct** connection: all four
hashes/timestamps matched the repository, no pending migrations, no duplicate
history rows. No migration files, schema definitions or driver were changed.

The actual `createDatabaseConnection` factory was compiled into a temporary
validation directory and exercised against the **pooled** runtime hostname.
Both direct and pooled sockets used `sslmode=verify-full`; client-side checks
confirmed encryption and certificate authorization. The MCP SQL proxy's internal
`pg_stat_ssl` hop reported false initially; that proxy observation was not used
as evidence about external TLS. Real `pg` sockets verified external TLS instead.

Verified on staging:

- Seven application tables: sessions, conversations, messages, stream_requests,
  usage_reservations, usage_utterances, api_rate_buckets.
- Five enums, 25 validated constraints (7 primary keys, 8 foreign keys, 6 unique
  constraints, 4 checks), 21 indexes including constraint-backed indexes.
- Catalog definitions include cascade ownership FKs, SET NULL billing FKs,
  token/request uniqueness, deterministic retrieval indexes and usage bounds.
- Runtime timeout defaults: statement 5s, lock 3s, idle-in-transaction 10s. The
  actual pooled connection preflight accepted these defaults without a restart.
- Eight transactional probes: valid owned message insertion; duplicate token-hash
  rejection; invalid role rejection; missing parent rejection; null-content
  rejection; nonpositive counter rejection; over-800-character utterance
  rejection; schema CREATE denied to the app role. All fixture changes rolled
  back. Sessions, conversations and messages each contain zero rows afterward.

Credentials traveled from MCP to the verification process through non-echoing
terminal input. They were not printed, put in command arguments, stored in files,
committed, or written into existing environment files. The temporary validation
script contains no credentials. All validation pools were closed afterward.

## Connection configuration for the next milestone

Obtain values privately from the Neon console for this project and the intended
branch/database/role. No credentials are included in this report.

- `DATABASE_URL`: staging `lain_app`, pooled hostname (`-pooler`), verified TLS.
- `DATABASE_MIGRATION_URL`: staging `lain_migrator`, direct hostname (no
  `-pooler`), verified TLS. Keep this operator/CI-only, outside Netlify Functions.

MCP's connection-string tool returned pooled hostnames by default for both roles.
For the direct validation, only the documented hostname pooling suffix was
removed; database/role credentials remained unchanged. Do not accidentally use
the default **production** branch when copying a connection string. Do not put
migration-owner credentials in the runtime slot.

Netlify runtime variable names remain: `DATABASE_URL`, `OPENAI_API_KEY`,
`OPENAI_MODEL`, `LAIN_AI_MODE`, `USAGE_TRUSTED_PROXY`, `USAGE_IP_HMAC_KEY`,
`USAGE_TEXT_INPUT_USD_PER_MILLION`, `USAGE_TEXT_CACHED_USD_PER_MILLION`,
`USAGE_TEXT_OUTPUT_USD_PER_MILLION`, and reviewed `USAGE_*`, `API_*`, `STORAGE_*`,
`SESSION_EXPIRED_RETENTION_DAYS`, `API_CLEANUP_BATCH`, `SESSION_CLEANUP_APPLY`
settings from `.env.example`. See [Netlify readiness](netlify-production-6e.md)
for scopes/defaults. No values were installed in Netlify. Production voice remains
server-disabled and cleanup should remain dry-run.

## Boundary and next step

Staging database onboarding is complete. Production migrations/runtime-role
provisioning need a later explicit production rollout decision. Hosted Netlify
adapter/IP-context, SSE/disconnect, HTTPS-cookie and scheduler checks remain.
The free organization remains subject to its quotas and shared project/branch
consumption; this task did not raise limits or guarantee capacity under load.
No OpenAI requests or local PostgreSQL operations were performed. Application
lint/typecheck/regression suites were not repeated because application code and
schema files are unchanged; validation was focused on the new staging database.
