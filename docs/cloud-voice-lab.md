# OpenAI Voice Lab — Milestone 5F.1

Run `npm run dev` and open `http://localhost:3000/dev/cloud-voice` (adjust the port if needed). Use the canonical localhost development origin for the existing same-origin validation. Set the existing server-only
`OPENAI_API_KEY` in your untracked environment file to enable manual evaluation.
The page and `POST /api/dev/cloud-voice` are unavailable outside development.
Keep the development server private/local. Configure PostgreSQL/session access and
apply the existing usage migration: the lab uses the same persistent reservation,
quota and budget protections as chat speech; see [usage protection](api-usage-protection.md).

The lab is isolated from main-chat voice configuration and personality. An explicit
generation click initializes/reuses the anonymous session before admission; cached
replay makes no paid request.
No microphone is requested. No speech model assets are downloaded. There are no
new dependencies: the installed official OpenAI SDK's native server WebSocket
transport is used. The obsolete local inference dependencies and previews have
been removed; the shared Refined DSP remains available for comparison.

## Manual evaluation

Choose Marin, Shimmer, Coral or Cedar, edit up to 800 characters, select Original
or Refined, then press **Speak · billable request**. Every evaluation requires a
new explicit action. Changing voice or effects never starts generation. One
request is allowed at a time. Volume can change during playback. Stop aborts the
HTTP reader, closes the upstream connection and clears all scheduled audio.
Closing/navigating away from the page does the same. Already generated audio can
still incur charges after cancellation.

The server opens a fresh `gpt-realtime-2.1-mini` Realtime session per evaluation,
disables turn detection, selects PCM16 mono at 24 kHz, and requests a single
out-of-band audio response with supplied text as user input. Server-owned
instructions request exact narration without additions, omissions or paraphrasing
and the approved calm, gentle, feminine, airy, composed direction. Tools and
microphone input are not used. Realtime is generative: exact wording and timbre
are requested, not guaranteed. Review the returned transcript and listen before
approving a voice. Refusals, pronunciation differences and omissions remain
possible; there is no automatic retry or extra billable corrective request.

The server relays Base64 PCM deltas via POST SSE (`audio`, `done`, `error`), so
playback begins before the entire response is available. The browser batches
samples into 100 ms buffers plus a final short buffer, schedules them on the
AudioContext clock and uses an 80 ms initial/recovery lead. Delayed networks can
still cause underruns. This HTTP relay is deliberately small and isolated; the
official docs recommend WebRTC for more robust client media delivery under
uncertain network conditions. This prototype does not implement a WebRTC/media
server or change main-chat streaming.

Refined imports the existing `createRefinedGraph`, `createRefinedImpulse` and
preset. Its exact filters, ring modulation, deterministic room impulse,
compression, master gain and pitch are reused. One shared graph and continuous
pitch envelope span the PCM stream; sources after the first continue at the
approved target pitch rather than restarting the ramp per network packet.
Original bypasses those effects and uses only volume and analysis. Both feed the
existing audio-reactive orb without changing its appearance or shaders. Orb
reactivity is attached during actual scheduled playback and reset after Stop or
completion. Reduced motion remains handled by the existing orb.

## Limits and measurements

- Strict same-origin JSON POST, `confirmed: true`, supported voice and text only.
  Client-supplied instructions/models/extra fields are rejected.
- Existing bounded UTF-8 JSON reader (32 KiB) and an 800-character text limit.
- One active upstream request per server handler/process, 30-second deadline,
  2,048 output-token cap and 60-second PCM-output cap. No background retries.
- Client playback/evaluation bounded to 90 seconds. Audio buffers and sample
  batching are bounded; cancellation rejects stale data and clears resources.
- Credentials and raw provider errors never reach the browser. No content or
  credential logging; no permissive CORS or persistent storage.
- Time to first audio is measured from Speak to the first non-zero post-DSP
  analyser sample. It is an audibility proxy, not physical speaker latency; zero
  volume or silent output may leave it unavailable.
- Total generation time includes server connection/configuration and generation,
  excludes final audio drain, and is separate from playback duration.
- Cost is estimated from returned input/cached-text/output-text/output-audio usage
  at standard model token rates checked 2026-11-14 ($0.60/$0.06/$2.40/$20 per
  million respectively). Missing usage shows unavailable. Taxes, regional
  uplifts and future price changes are not included. Interrupted/failed requests
  may incur cost without returning usage.

## Official sources

- [Model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini)
- [Realtime text input, audio deltas and voices](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [Realtime WebSocket transport](https://developers.openai.com/api/docs/guides/realtime-websocket)
- [Pricing](https://developers.openai.com/api/docs/pricing)

## Validation

`npm run test:cloud-voice` uses injected mock Realtime connections, synthetic PCM
and fragmented SSE events. It makes no OpenAI calls. Tests cover development-only
access, origin/confirmation/input bounds, one-request concurrency, narration
payloads, PCM event order, usage estimate, cancellation/deadline/cleanup, safe
errors, progressive parsing, sample scheduling, original/Refined graphs and no
Kokoro/microphone imports. Existing DSP equivalence tests remain in
`npm run test:voice`. Lint and typecheck are also required.

No live OpenAI speech was generated during implementation. Actual model access,
quality, cloud latency and costs must be evaluated manually with the billable
Speak control. No production build or deployment is part of this milestone.


Validation completed: lint and typecheck passed; all 10 focused mock tests passed.
One focused Chromium workflow exercised Refined playback through completion, then
Original/Shimmer playback and Stop. The existing canvas stayed mounted; the actual
orb audio-RMS uniform rose to 0.73 with synthetic audio and returned to zero after
Stop. No workers, microphone requests or Kokoro/model downloads occurred. These
are synthetic validation results, not cloud voice latency or quality measurements.
An empty-key local HTTP request returned the expected safe 503 configuration error.
The route uses the default Node runtime, matching existing routes: this project's
Next cache-components configuration rejects explicit runtime segment overrides.

## Voice design refinement

The lab now separates **vocal delivery instructions** (up to 1,200 characters)
from narration (800 characters). Delivery is sent only to the development lab
endpoint. Default/main-chat narration instructions and Shimmer/Refined settings
are unchanged; `/api/voice` still rejects extra delivery instructions. The model
and four existing voices are retained. Blank delivery requests neutral narration.

Choose Original (dry), the original approved Refined preset, Custom effects, or a
saved preset. Custom ranges are deliberately restrained: bass 0–8 dB, metal
0–20%, room 0–15%, pitch -3 to +1 semitones, carrier 30–120 Hz, doubling 0–8%.
The approved Refined filters, ring modulation, deterministic impulse, compression
and pitch ramps remain the comparison baseline. Custom doubling adds a 15 ms
filtered copy with gentle ±2 ms modulation, no feedback, and level compensation.
Custom processing adds a fast compressor and soft ceiling below 0.92 full scale.
Boundary fades and a short Stop fade reduce clicks. The baseline comparison keeps
the original DSP; only playback-boundary fades are added. Pitch changes playback
speed as in the existing Refined implementation; this is not independent pitch
correction/time stretching.

**Generate & speak** is the only billable action. After successful generation,
the lab retains one dry PCM take in memory (bounded to the existing 60-second
output limit and approximately 4 MB encoded data). Change effects and use
**Replay cached audio · free** to process those same samples again, with no fetch
or extra generation. A failed/cancelled new generation preserves the previous
successful take. Cache metadata shows the original text, voice and delivery;
changing those inputs does not change the cached recording. The cache is cleared
when leaving/reloading the page and is never stored with presets.

Effects are snapshots applied on the next playback; controls do not mutate a
scheduled pitch envelope mid-stream. Stop before replaying if audio is active.
This avoids clicks and timing gaps from live pitch rescheduling. Volume remains
adjustable during playback. The orb follows the actual processed analyser output.
Original generation latency/cost remain visible; local replay onset is measured
separately and must not be interpreted as cloud latency or another charged call.

**Save preset** retains up to 12 named presets in this browser's localStorage
under `lain.cloud-voice-design.v1`. A preset contains a version, name, voice,
delivery instructions and numeric DSP settings—no narration text, audio, API key
or main-chat preferences. **Export preset JSON** downloads the current preset
for review. Saved presets can be selected again from the menu. Preset changes,
saving and exporting never generate audio automatically or update the main chat.
There is no preset-import UI in this refinement.

New implementation is isolated in `design-presets.ts`, `design-cache.ts`,
`design-dsp.ts`, `design-player.ts` and the existing lab component/styles. The
shared relay accepts delivery only with an explicit lab-only option; default
calls and the main chat request shape remain unchanged.

Refinement validation: lint and typecheck passed; 27 focused mock tests passed.
A Chromium workflow generated one synthetic dry take, saved/exported a custom
preset, replayed it with custom effects and Original, and verified the generation
request count stayed at one. Stop reset orb audio input to zero and the existing
canvas stayed mounted. No speech workers, local model downloads, microphone
access or real OpenAI calls occurred. The mock workflow does not assess human
voice quality; compare actual cloud takes manually before approving a new preset.
