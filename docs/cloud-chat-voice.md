# Cloud chat voice — Milestone 5F.2

The main chat now uses `gpt-realtime-2.1-mini`, server-selected Shimmer and the
approved “Lain robo” DSP/delivery preset from `docs/references/lain-voice-preset.json`.
The legacy local neural engine and previews were removed in Milestone 5F.5.
Shared DSP, PCM players, segmentation and audio analysis remain.
No new dependencies, database/schema, personality, chat API or layout changes.

## Activation and playback

Run local development with the existing PostgreSQL/session setup and server-only
`OPENAI_API_KEY`. Cloud voice is blocked outside development on both the client
and `/api/voice`, with no production override. Do not expose the development
server publicly. As with existing session routes, use its canonical localhost
origin for same-origin requests.

Voice is off on every page load. Enable voice explicitly in the existing header
panel; there is no model-download dialog. The panel discloses AI-generated cloud
speech, paid narration and sending completed replies to OpenAI. Local cloud
preferences store only volume and the prior enabled preference, never credentials
or permission to autoplay. Legacy local-model download consent does not activate cloud
speech. Activation unlocks one reusable audio context without making a cloud call.

Only a newly completed live assistant response starts automatic narration. Text
streaming, failed/interrupted replies, history restoration and repeated completion
or reconciliation snapshots do not automatically speak. Use the existing per-
message Read control to replay a saved completed response. Markdown filtering
retains readable text while skipping fences, HTML and link destinations. Each
response is bounded to the first 800 spoken characters at a word boundary with a
visible truncation notice; the prototype does not split it into extra paid calls.
Faithful narration is requested by server-owned narration rules plus the approved Vocal Identity v2.0 delivery;
model wording/pronunciation cannot be guaranteed.

The existing PCM relay/parser, 100 ms sample batching, Refined filters/modulation/
room/compression/pitch and analyser are reused. Volume, Stop and per-message
controls are retained. The orb receives audio signals only during actual playback;
existing text Thinking/Talking and reduced-motion behavior are preserved. Stop,
new submissions, New Chat, switching/deleting the active conversation, disable,
page exit and unmount abort active speech and reject stale chunks. Stop clears
buffers/graph while retaining the activated context; disable/unmount close it.

## Endpoint and cost protections

`POST /api/voice`: `{ "requestId": "<uuid>", "text": "<filtered narration>" }`.
Same-origin credentials carry the existing HttpOnly anonymous-session cookie.
The server resolves an existing valid session; it never creates one or trusts a
client session ID. Shimmer, model and instructions are server-owned. The original
lab `/api/dev/cloud-voice` contract remains separate and unchanged.

- Existing bounded JSON reader: 32 KiB; text at most 800 characters.
- Session/input phase bounded to 5 seconds; generation to 30 seconds; output to
  2,048 tokens and 60 seconds of PCM. Client evaluation/playback bounded to 90 s.
- Persistent PostgreSQL admission controls cover every segment: configurable
  session/IP quotas, session/global concurrency and shared daily cost reservations.
  Failed/uncertain attempts count conservatively. Safe errors remain visible and
  are never automatically retried; see [usage protection](api-usage-protection.md).
- A session-scoped request UUID is reserved before calling the relay, alongside
  a text fingerprint (not conversation text). Identical or conflicting reuse
  returns 409 without another upstream call. Automatic playback uses the stable
  assistant UUID; explicit manual replay uses a fresh cryptographic UUID.
- Client in-flight guards and handled-message tracking prevent rerender/double-
  submission charges. No automatic speech retry occurs after an uncertain failure.
  A deliberate Read action is a new paid attempt and can still hit usage limits.

Milestone 5F.4 replaced process-local billing guards with persistent reservations
and uniqueness constraints. Public production voice remains disabled pending the
security milestone; durable accounting alone does not approve public rollout. Cancellation
may still incur charges for audio already generated; the UI does not promise a
refund or a complete cost estimate after cancellation.

## Files and verification

- `cloud-chat-voice-controller.ts`, `use-chat-voice.ts`, voice controls and their
  existing ChatWindow wiring: completed-response lifecycle and cloud disclosure.
- `lib/cloud-voice/player.ts`, `stream.ts`: reusable activated PCM playback and
  chat relay selection, preserving the lab workflow.
- `server/cloud-voice/chat-handler.ts`, `app/api/voice/route.ts`: session validation,
  Shimmer selection, duplicate and usage limits. Shared relay gains a completion
  callback so deadline/disconnect releases concurrency even if a body is unread.
- `tests/cloud-voice/chat*.test.ts`, `scripts/test-cloud-voice.mjs`: focused client
  and session/cost guard fixtures, with no real OpenAI calls.

Run `npm run test:cloud-voice` and `npm run test:voice`. Lint and typecheck also
pass. One focused Chromium mock workflow verified silent streaming text, one
completion request, manual replay, Stop, audio-reactive uniforms resetting to
zero, the same orb canvas, no microphone requests and zero speech workers/model
downloads. No paid calls or production builds were made during validation.

The user's approved lab measurements (1.77 s first audio, 2.01 s generation,
$0.002057 estimated cost) were not remeasured here. Progressive speech during
text streaming is intentionally deferred. Recommended next work: evaluate the
completed-response flow manually before a separate progressive-speech milestone.

Final focused results: `npm run lint` and `npm run typecheck` passed;
`npm run test:cloud-voice` passed 21 tests and `npm run test:voice` passed 12 tests.


## Approved preset — 15 November 2026

“Lain robo” is now selected for main chat: Shimmer, bass 4 dB, metal 6%, room
12%, pitch -1.5 semitones, carrier 55 Hz, doubling 7%. The supplied JSON remains
the canonical source; `lib/cloud-voice/approved-preset.ts` validates and freezes
it. Client playback reuses the exact design-lab graph, including doubling,
headroom protection and boundary fades. The server injects the approved delivery
text into its internal relay request; public `/api/voice` callers still cannot
supply or override delivery/effects. Lab experiments and saved browser presets do
not change this selection. The chat model personality prompt is unchanged.

Completed-response playback, activation, Stop, volume, session checks, duplicate
protection, usage limits and development-only availability remain in force.
Validation: lint, typecheck and 29 focused cloud-voice tests passed. No billable
speech requests were made while applying this preset. Next, listen to a completed
reply manually with voice enabled to confirm the selected sound in context.

## Milestone 5F.3 update

Live replies now use bounded progressive narration. See
[progressive-cloud-speech.md](progressive-cloud-speech.md) for segmentation,
shared server budgets, unchanged approved preset and validation. This supersedes
this document's completed-response-only description. Manual replay is retained.
