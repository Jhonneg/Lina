# Public portfolio launch configuration

This supersedes the private staging rollout requirement. The user approved a
public portfolio deployment, temporary authentication disabled, and production
main-chat voice prepared for manual testing. No deployment, credential setup,
database mutation or billable request was performed for this change.

## Netlify dashboard

Use **ai-lina → Project configuration → Environment variables**, Production deploy
context (the `main` deploy at `ai-lina.netlify.app`). Use Functions scope when
available; otherwise All scopes. None of these variables use `NEXT_PUBLIC_`.
`netlify.toml` already selects Node 24; do not override `NODE_ENV` or add another
hosting configuration.

Set these three private values:

| Name | Value |
| --- | --- |
| `DATABASE_URL` | The existing migrated Neon **staging** branch's pooled URL, database `lain`, role `lain_app`, with `sslmode=verify-full`. Copy the password privately from Neon. |
| `OPENAI_API_KEY` | Your OpenAI project's API key. |
| `USAGE_IP_HMAC_KEY` | An independent random value generated privately with `openssl rand -hex 32`. Used for privacy-preserving IP rate limits. |

The correct pooled host is
`ep-round-bar-be4dze6s-pooler.c-9.us-east-2.aws.neon.tech`. Keep the password out of
this document/source/chat. The Neon project display name is `lina-ai`. Its
production branch is still unmigrated: **do not use that empty branch for this
initial public test**. No data migration or new database is necessary for testing
the current deployment with the existing migrated branch.

Paste these non-secret values into Netlify:

```dotenv
STAGING_ACCESS_MODE=disabled
LAIN_AI_MODE=openai
OPENAI_MODEL=gpt-6-luna
LAIN_VOICE_ENABLED=true

USAGE_TRUSTED_PROXY=netlify
USAGE_DAILY_BUDGET_USD=0.50
USAGE_TEXT_INPUT_USD_PER_MILLION=0.10
USAGE_TEXT_CACHED_USD_PER_MILLION=0.01
USAGE_TEXT_OUTPUT_USD_PER_MILLION=0.50

USAGE_TEXT_HOURLY_LIMIT=10
USAGE_TEXT_DAILY_LIMIT=30
USAGE_SPEECH_HOURLY_LIMIT=12
USAGE_SPEECH_DAILY_LIMIT=30
USAGE_SPEECH_MINUTE_LIMIT=3
USAGE_SESSION_CONCURRENCY=2
USAGE_GLOBAL_CONCURRENCY=4
USAGE_IP_MINUTE_LIMIT=12
USAGE_IP_HOURLY_LIMIT=40

STORAGE_CONVERSATIONS_PER_SESSION=10
STORAGE_MESSAGES_PER_SESSION=200
SESSION_EXPIRED_RETENTION_DAYS=7
API_CLEANUP_BATCH=100
SESSION_CLEANUP_APPLY=false
```

Keep existing non-billable `API_SESSION_*`, `API_CREATE_*`, `API_READ_*`,
`API_MUTATE_*` defaults; they are already enforced and do not need dashboard
entries. `.env.example` lists their existing defaults. The table/block above is
complete for this recommended setup; optional API overrides are unnecessary.

Do **not** set `DATABASE_MIGRATION_URL`, `POSTGRES_PASSWORD`,
`STAGING_ACCESS_SECRET`, `API_ACCESS_*` or any `NEXT_PUBLIC_*` secret in Netlify.
The operator gate stays inactive through the explicit disabled setting; its
production fallback remains fail-closed if the setting is accidentally omitted.
Existing local `.env` files were not changed.

## Models, voice and cost behavior

Retain the currently configured text model `gpt-6-luna`. Its standard short-context
prices, checked 15 November 2026, are $0.10 input / $0.01 cached input / $0.50 output
per million tokens. The app's bounded context stays far below long-context pricing.
These settings assume standard direct OpenAI processing, not a different service
tier, regional uplift or hosting AI gateway. Update rates when changing model/tier.
[Official model/pricing reference](https://developers.openai.com/api/docs/models/gpt-6-luna).

`LAIN_VOICE_ENABLED=true` explicitly permits the existing **main chat** endpoint
in production. `false` disables it. The `/dev/cloud-voice` page and
`/api/dev/cloud-voice` lab remain development-only. Browser voice still starts
disabled and requires a current-visit playback gesture. No `NEXT_PUBLIC_` voice
flag, separate speech key, voice-model variable or local model download is needed.

Voice remains `gpt-realtime-2.1-mini`, Shimmer, with the exact approved Lain robo
instructions/DSP and progressive PCM pipeline. Existing hardcoded estimates match
current standard rates: text $0.60/$0.06/$2.40 and audio output $20 per million
tokens. [Official voice pricing](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini).
Sessions, same-origin checks, stable IDs, persistent reservations, cancellation,
concurrency and 800-character/three-segment limits remain enforced.

Text and speech share one estimated **$0.50 per UTC day** global budget across
all sessions. The fallback budget is also lowered to $0.50. Worst-case reservations
can reject new work before actual settled spend reaches that figure; interrupted
unknown usage stays charged conservatively. This is the existing application's
estimated spend limit, not a guaranteed provider invoice ceiling. Speech quotas
count **segments**, so a three-segment reply uses three attempts. Keep the minute
limit at least three so progressive speech can complete. Session concurrency two
allows text streaming and speech together.

## What changed and how to test next

The environment example now recommends public mode, conservative limits, explicit
production voice and matching text pricing. The main voice server gate recognizes
the new opt-in and forwards already authorized/reserved requests to the existing
PCM relay; the lab gate is unchanged. The browser's development-only refusal and
outdated disclosure were removed. No preset, personality, shader, layout, driver,
schema, migration, dependency or usage-accounting algorithm changed.

Local validation: lint/typecheck passed; 41 mocked cloud-voice tests and four usage
tests passed, including the new production opt-in, session requirement, disabled
flag, production lab rejection, explicit playback activation and $0.50 fallback.
The six existing staging-access tests also verify that explicit disabled mode
bypasses the optional gate. No remote configuration was installed.

After you configure the dashboard and approve deployment, deploy the updated code
and manually test: send one message, reload to restore it, enable voice and listen,
then test Stop/New Chat. These manual generations will be billable; none were
performed here. Verify that session initialization succeeds on Netlify before
sending. If it returns a trusted-IP/accounting 503, inspect Netlify SDK request
context rather than disabling the protections. Existing hosted stream/disconnect
checks remain manual validation items, not new infrastructure or auth requirements.
