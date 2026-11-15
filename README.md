# Lain 2.0

Lain is a conversational AI web app centered around a compact procedural 3D orb. It combines streamed assistant replies, anonymous persistent conversations, and optional cloud speech in a restrained plum, amber, and gold interface. Lain's server-side personality instructions are versioned and kept separate from conversation messages.

## Technology

- Next.js App Router, React, and TypeScript
- Three.js and React Three Fiber for the Noise Orb
- PostgreSQL with Drizzle ORM for sessions, conversations, messages, and usage accounting
- OpenAI Responses API for text and Realtime API for optional speech
- Netlify OpenNext and Neon PostgreSQL for hosting

## Local development

Requirements: Node.js 24 and npm. Docker Compose is needed for local PostgreSQL.

Install dependencies and prepare local configuration:

```bash
npm ci
cp .env.example .env
```

Set a strong local `POSTGRES_PASSWORD` in `.env`. Set `DATABASE_URL` to the Compose database, using the same password URL-encoded:

```text
postgresql://lain:URL_ENCODED_PASSWORD@127.0.0.1:5432/lain_dev
```

Start PostgreSQL and apply the reviewed migrations:

```bash
docker compose up -d --wait postgres
npm run db:migrate
```

Run with deterministic mock chat. This does not need an OpenAI key:

```bash
LAIN_AI_MODE=mock npm run dev
```

Visit <http://localhost:3000>. The development mock is intentionally unavailable in production. Real text generation requires a server-side `OPENAI_API_KEY`, `OPENAI_MODEL`, and explicit `LAIN_AI_MODE=openai`, along with a configured database, trusted IP protection, and usage pricing/limits. Keep secrets in ignored environment files or the hosting provider's secret store; never use `NEXT_PUBLIC_` for credentials.

To stop PostgreSQL while retaining its data volume:

```bash
docker compose stop postgres
```

`docker compose down` also stops and removes the container and network but preserves the named data volume. Do not remove that volume if you need its database contents.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server |
| `npm run build` | Create a production build |
| `npm run start` | Serve a production build |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Check TypeScript types |
| `npm test` | Run the main mocked regression suite |
| `npm run test:netlify` | Test Netlify runtime and scheduled cleanup behavior |
| `npm run test:usage` | Test usage quotas and accounting |
| `npm run test:abuse` | Test non-billable abuse controls |
| `npm run test:cloud-voice` | Test cloud voice and progressive audio behavior with mocks |
| `npm run db:generate -- --name=change_name` | Generate a Drizzle migration |
| `npm run db:migrate` | Apply pending migrations to the configured database |
| `npm run sessions:cleanup` | Preview bounded expired-session cleanup |

Database migrations are explicit; the application does not apply them at startup. Check which database `DATABASE_URL` or `DATABASE_MIGRATION_URL` targets before running migration or cleanup commands. PostgreSQL integration scripts expect isolated disposable databases and must not be pointed at `lain_dev` or any database containing user data.

## Application behavior

Anonymous browser sessions use an opaque HttpOnly cookie. The server stores only a hash of the session token and derives conversation ownership from that cookie. Conversations and messages persist in PostgreSQL and can be restored from the URL. The history drawer supports resuming, renaming, and deleting conversations.

Assistant text streams over `POST /api/chat/stream` as server-sent events. Requests are bounded and checked for session ownership and same-origin access. Persistent database-backed quotas, concurrency limits, idempotency, and a shared estimated daily budget protect billable OpenAI requests; accounting failure blocks provider calls. The documented public launch configuration currently recommends a `$0.50` estimated daily global budget. Estimates and conservative reservations are not a guaranteed provider invoice ceiling.

Optional speech is cloud-generated using the approved Shimmer voice and Lain robo preset. It is off by default in the browser and requires an explicit user action to activate. Production availability is separately controlled by server configuration. The development voice lab is at `/dev/cloud-voice`; it does not load local speech models and is restricted to development.

## Deployment

Netlify with Neon is the deployment target. Follow [public launch configuration](docs/netlify-public-launch.md) for recommended environment variable names and conservative defaults. The [Netlify readiness guide](docs/netlify-production-6e.md) covers direct migration and pooled runtime connections, role timeouts, scheduled cleanup, deployment checks, and rollback. Keep the pooled `lain_app` connection in the application runtime; use the direct migration role only for operator-run migrations. Never place migration credentials in the runtime environment.

## Documentation

- [Project context](PROJECT_CONTEXT.md) — product goals and approved design decisions
- [Implementation plan](IMPLEMENTATION_PLAN.md) — milestone scope and progress
- [Application security](docs/application-security.md) — security controls and residual deployment risks
- [Non-billable abuse protection](docs/non-billable-abuse-protection.md) — rate limits, storage caps, and cleanup
- [API usage protection](docs/api-usage-protection.md) — paid request quotas, idempotency, and accounting
- [Voice engine](docs/voice-engine.md) — cloud speech pipeline and approved audio processing
- [Progressive cloud speech](docs/progressive-cloud-speech.md) — segmentation, ordering, and cancellation
- [Dependency security](docs/dependency-security.md) — audit findings and mitigations
- [Performance review](docs/performance-6c.md) — measured performance work and limitations
- [Mobile and accessibility review](docs/mobile-accessibility-6d.md) — responsive and accessibility findings
