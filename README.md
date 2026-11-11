This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Server-side chat API (Milestone 3A)

The UI still uses its existing local simulation. The new backend is independently
available at `POST /api/chat`; it does not stream yet.

Copy the variable names from `.env.example` into your server environment (or a
git-ignored `.env.local`). Never use `NEXT_PUBLIC_` for these values:

| Variable | Configuration |
| --- | --- |
| `LAIN_AI_MODE` | `mock` only in development; explicitly set `openai` to enable real calls. Unset/invalid modes fail closed. |
| `OPENAI_API_KEY` | Required only in `openai` mode. Server-side secret; leave blank for mock verification. |
| `OPENAI_MODEL` | Required only in `openai` mode. Choose an available Responses API model; there is no hardcoded model fallback. |

Start a development mock without an API key:

```bash
LAIN_AI_MODE=mock npm run dev
```

```bash
curl http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

Success: `{"ok":true,"message":{"role":"assistant","content":"..."}}`.
Errors: `{"ok":false,"error":{"code":"INVALID_REQUEST","message":"..."}}`.
Send only `messages` at the root, and only `role`/`content` per message; omit UI IDs.
Roles are restricted to `user` and `assistant`. Content is trimmed; blank messages
are rejected. Limits are 20 messages, 4,000 UTF-16 code units per message,
12,000 combined code units, and 32 KiB of actual UTF-8 JSON bytes (including JSON
syntax). Compressed bodies are rejected. Origin-bearing requests must match the
endpoint origin; no permissive CORS headers are emitted.

HTTP errors: 400 invalid input, 403 disallowed origin, 413 oversized body,
415 unsupported media, 408 cancellation, 503 missing/disallowed configuration,
502 upstream failure/empty or incomplete output, 504 timeout, or 500 unexpected
failure. Responses are not cached; errors omit provider details and user content.

The server-only provider uses the official [OpenAI Responses SDK](https://developers.openai.com/api/reference/typescript),
`store: false`, a 768-output-token cap, no automatic retries, SDK logging disabled,
and a 20-second SDK timeout. A 25-second overall deadline also bounds slow body
uploads and stalled adapters. Configure the deployment's function/proxy timeout
to allow that deadline to return a JSON error.

`npm test` runs focused Node built-in tests with TypeScript compiled into a temporary
directory (Node 24 for the test runner). SDK calls use fake transports and external
fetch is blocked in tests; no paid requests are needed. Mock mode fails closed
outside `NODE_ENV=development`, even if credentials are present.

**Before public deployment:** this anonymous endpoint still needs rate limiting,
concurrency/cost budgets and abuse protection at the gateway/application layer.
Payload limits, origin checks and timeouts do not prevent direct clients from
making repeated calls. Enforce upload limits at the reverse proxy too. Do not
deploy the real provider until these controls and the chosen model's cost/output
budget have been reviewed. The app does not log full conversations or credentials.

### Backend streaming (Milestone 3B)

`POST /api/chat/stream` accepts the same JSON request and limits as `/api/chat`.
The existing endpoint and local-demo frontend are unchanged. Verify streaming
without API credits using `LAIN_AI_MODE=mock npm run dev`, then:

```bash
curl -N http://localhost:3000/api/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Hello"}]}'
```

The POST response uses SSE with JSON payloads and blank-line frame separators:

```text
event: delta
data: {"text":"incremental text"}

event: done
data: {"finishReason":"completed"}

```

On stream failure, `event: error` carries `{"code":"AI_UNAVAILABLE","message":"..."}`
(or a safe timeout/internal error code) and closes without `done`. Validation and
configuration failures return the existing JSON error envelope with an HTTP error
status before opening SSE; after opening, failures use SSE because HTTP status is
already 200. Treat EOF without `done` as interrupted output. Partial text can
precede an error; there are no retries or resumable event IDs.

Streams share the 25-second overall deadline, 768-token provider cap and server-only
configuration. They additionally limit emitted text to 16,000 UTF-8 bytes and use
demand-driven reads. Client disconnects or cancelling the response reader abort
provider work; completion/error/cancellation clears timers and closes iterators.
Mock chunks arrive every 80ms and remain development-only. In browsers use POST
`fetch` and its response reader; native `EventSource` uses GET. Hosting/proxies must
support streaming and disconnect propagation; buffering is discouraged by response
headers but needs verification on the deployment platform. Public-deployment abuse
protections described above are still required. `npm test` covers both endpoints
with fake SDK transports; no billable calls are made.

### Database foundation (Milestone 4A)

PostgreSQL uses Drizzle ORM with `pg` (node-postgres). Set `DATABASE_URL` in your
ignored `.env.local` or server environment using a PostgreSQL connection URL.
Drizzle CLI loads Next.js environment files through `@next/env`. Do not use a
`NEXT_PUBLIC_` variable or commit real credentials. Configure verified TLS according
to your database provider; this setup does not disable certificate verification.

```bash
npm run db:generate -- --name=describe_schema_change  # Offline SQL + metadata
npm run db:migrate                                  # Applies pending SQL to DATABASE_URL
```

Generated migrations and their `drizzle/meta` journal/snapshots belong in source
control. Review SQL and confirm the target database before applying; migrations
are explicit commands and never run on application startup. PostgreSQL 13+ provides
the `gen_random_uuid()` used by primary-key defaults without an extra extension.
No PostgreSQL instance is provisioned by this project.

The schema in `src/server/db/schema.ts` defines sessions, conversations and messages.
Deleting a session cascades to its conversations and messages; deleting a
conversation cascades to its messages. Token hashes are uniquely indexed;
conversation listing uses `(session_id, updated_at DESC, id)` and ordered message
retrieval uses `(conversation_id, created_at, id)`. An expiration index supports
future cleanup, but no cleanup/session logic is implemented. Store only token
hashes in `token_hash`, never raw session tokens.

All timestamps use `timestamptz`; creation/update timestamps default to database
`now()`. Expiration must be supplied explicitly. `updated_at` is initialized on
insert and must be advanced by future persistence code; no update trigger exists.
Database enums enforce user/assistant roles and completed/interrupted/failed
message status (default completed). The UUID tie-breakers give deterministic order
when timestamps match; they do not represent insertion sequence.

Future server code can call `getDatabase()` from `src/server/db`. Importing that
module does not read configuration or open connections. The first call validates
configuration and creates a pool (max 5); sockets open only for actual queries.
Development reloads reuse the pool. Pool sizing and provider connection limits
must be reviewed for the eventual hosting platform. No application code currently
calls this client, so mock/streaming chat, tests and UI builds work without a
database. There are no cookies, sessions, CRUD routes or persistence yet.

`npm test` includes offline schema/migration and lazy-client checks; it never
applies migrations or queries a live database. Initial SQL has not been applied
to a database; supply an explicitly chosen local test database to verify it there.
