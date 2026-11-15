# Progressive cloud speech — Milestone 5F.3

Main chat now starts cloud narration at an eligible linguistic boundary while
assistant text is still streaming. The approved `Lain robo` JSON, delivery,
Shimmer voice, gpt-realtime-2.1-mini model and DSP parameter values are unchanged.
No UI, orb appearance, personality, database or dependency changes.

## Segmentation and prefetch

`CloudSpeechBuffer` reuses the existing Markdown AST filtering and sentence/phrase
segmenter with an 800-character limit for the whole utterance. Incomplete sentences
and ambiguous inline markup wait; code fences, HTML and link destinations are
excluded. Completion flushes eligible remaining words. Abbreviations and decimals
use the existing conservative English heuristics; they are not a multilingual
linguistic guarantee. A rewritten already-consumed prefix stops speech with an
accessible error rather than replaying or silently replacing spoken words.

There are at most **three paid segments per live reply**. The first two batches
use currently available complete linguistic units. After two calls, the last
batch waits for final text or exhaustion of the 800-character budget, retaining
all eligible remaining text within that budget. This bounds per-reply requests
without dropping additional sentences merely because three batches are enough.
Manual replay and completed-response fallback still use one bounded request.

Only one upstream generation runs at once. As soon as its stream completes,
the next ready segment starts while previously received PCM is still playing.
No model instances, connections or queues grow with the number of text deltas.
Text buffers stay bounded (existing 16,000-character Markdown source cap plus
800 spoken characters). PCM is bounded to 60 seconds across the whole utterance.

## Playback and cancellation

One `DesignVoicePlayer`, activated AudioContext, analyser, clock and approved DSP
graph span all segments. `finish()` runs only once at overall completion.
`endSegment()` flushes partial 100 ms PCM blocks, preserving final samples instead
of dropping them or mixing partial blocks with the next segment. Source-only
4 ms edge envelopes smooth independent waveform seams; approved DSP values,
modulation/reverb state and continuous pitch rate are retained. Already-ready
buffers meet on the audio clock without an intentional inter-segment pause.

Stop, new submissions, New Chat, navigation/switching, disable and disposal abort
the active request, discard queued words, clear scheduled PCM and reject late
chunks. A cancelled in-flight server segment closes that sequence. If generation
already finished and the client was waiting for more text, no provider connection
remains open; client cancellation discards future queued work. Interrupted/failed
text generation stops automatic voice. Completion, reconciliation, restoration
and repeated React observations never automatically replay handled messages.
Explicit Read is a new manual paid attempt, with a new request UUID.

Orb analysis is attached only during actual playback, and reset during silence or
Stop. The existing text Thinking/Talking behavior and reduced motion remain intact.

## Server contract and budgets

`POST /api/voice` remains session-protected and development-only. Existing requests
stay compatible: `{ "requestId": "<uuid>", "text": "..." }`.
Progressive calls add `"segment": { "index": 0, "final": false }`, with the
same request UUID for the utterance and consecutive indices 0–2. The last eligible
batch has `final: true`. SSE `audio`, `done`, `error` are unchanged.

The server binds sequences to the verified anonymous session, rejects skipped,
repeated/conflicting, expired or closed segment sequences, and reserves each
attempt before the provider call. Client-selected voice/delivery/DSP remain
rejected. Reservations include a text fingerprint and segment flags, not raw
conversation content. An in-flight duplicate is rejected by the existing
concurrency guard; later duplicates receive 409.

**Segmentation does not create new allowances:**

- At most 800 characters summed across segment texts and separating spaces.
- At most 30 seconds of aggregate upstream generation/connection time and 60
  seconds of output PCM per utterance. Each relay receives only remaining time
  and audio-byte headroom. Authentication/body reads remain bounded to 5 seconds.
- Each individual generation counts against the existing **3 attempts/minute per
  session and 20 attempts/hour per process**, including uncertain/failed attempts.
- At most one active upstream request; at most three segments; sequence/client
  lifetime at most 90 seconds. No automatic retry of a billable request.
- Existing 2,048-token cap per provider response and bounded JSON reader remain.

Hitting a quota or receiving a generation/network error stops speech visibly;
words cannot be guaranteed after such a failure. Limits can reject a later batch
when prior requests already consumed the minute/hour quota. Cancellation may
still incur charges. Guards remain bounded, per-process, in-memory, retained for
one hour, and reset on restart. Public production remains disabled pending durable
abuse/cost controls.

## Validation and limitations

- Lint and typecheck passed.
- `npm run test:cloud-voice`: **39 tests passed**, including segmentation, ordered
  prefetch, final flush, duplicate suppression, cancellation, shared budgets,
  source continuity, approved preset identity and existing voice/session guards.
- `npm test`: **109 server/chat tests and 7 rendering tests passed**.
- One Chromium workflow with mock text SSE and synthetic PCM verified audio before
  text completion, code exclusion, final phrase flush, sequential shared request
  IDs, no automatic replay on completion, manual replay, Stop, zero speech workers
  or microphone requests, reset orb uniforms and the same mounted canvas. Its 28
  automatic PCM buffers had no meaningful scheduled gaps (floating-point residual
  below 1 ms). This is not a real cloud latency or voice-quality measurement.

Cloud/network starvation can still produce gaps, and separate Realtime responses
may vary in prosody despite identical approved voice/delivery instructions. The
third-batch completion hold can also wait for a slow text stream. No real speech
API calls, local-model downloads, production builds or preset changes occurred.
Recommended next task: manually listen to progressive Lain robo narration under
normal and slow text streaming before adjusting batching policy or quotas.

## Changed files

- `components/chat/cloud-chat-voice-controller.ts`, `cloud-speech-buffer.ts`:
  progressive lifecycle, bounded grouping, completion/retry/cancellation guards.
- `components/chat/speech-segmenter.ts`: optional cumulative budget; previous
  local-voice default remains 4,000 characters.
- `lib/cloud-voice/stream.ts`, `design-player.ts`: segment request metadata,
  partial PCM flush and smooth source boundaries within one playback graph.
- `server/cloud-voice/chat-handler.ts`, `handler.ts`: grouped reservations and
  cumulative generation/audio budgets, preserving lab/default behavior.
- Focused cloud tests and their existing runner; this documentation.
