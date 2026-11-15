# Progressive speech — Milestone 5E.5

With voice consent and playback activation already granted, the main chat now
speaks eligible segments during SSE output. No backend or SSE contract changed.
The optional synchronous state observer in usePersistentChat delivers start,
metadata, delta and finish transitions even when React batches a short response
into one render. The ordinary React observer remains idempotent and handles
restoration/navigation. Voice errors cannot throw through the text state updater.

## Text eligibility and bounds

`speech-segmenter.ts` buffers at most 16,000 source units and uses the existing
remark/GFM AST. Fenced/indented code, HTML and definitions are skipped; ambiguous
inline delimiters, unfinished links and incomplete inline code are held. A stable
prefix before incomplete markup can still speak. Unresolved trailing structures
are omitted at completion rather than reading their syntax. Formatting-heavy
responses can therefore start later than plain prose.

Sentence boundaries use Intl.Segmenter("en") with conservative abbreviation and
initial/acronym guards. Decimal tokens and words remain intact. The first complete
sentence is eligible as soon as its boundary is confirmed; punctuation at the end
of a network fragment waits for whitespace/following context or completion. Later
sentences are grouped around 240 units when already available. Long prose can
split at clause/word boundaries, never in a word; one segment is at most 600 UTF-16
units. Oversized unbroken tokens are omitted. These are conservative English
heuristics, not a guarantee for every domain-specific abbreviation. Browsers without
Intl.Segmenter conservatively fall back to word/phrase bounds and completion;
missing sentence segmentation never prevents text chat from loading.

Completion flushes the remaining eligible phrase. The existing total budget of
4,000 spoken UTF-16 units is shared across all segments of a response. The queue
holds at most eight waiting text segments; backpressure leaves remaining text in
the bounded segmenter instead of creating more work. Audio is bounded to the
currently playing buffer plus one upcoming segment (preparing or ready).

## Generation, playback and cancellation

VoiceEngine.prepare() owns one independent provider request and returns a decoded
AudioBuffer without stopping current playback. VoiceEngine.play() starts prepared
audio without cancelling that preparation slot. Natural playback endings also
leave preparation intact. The controller prepares the next segment while audio
plays, waits for the actual end event, then plays the ready buffer in order.
There is still exactly one worker/model instance and no parallel inference.
The approved Nicole settings, WAV conversion and Refined DSP are unchanged.

Stop, disable, new text submission, conversation switch, New Chat, unmount and
pagehide abort both lanes and discard text/prepared buffers. Job identity and
AbortSignals reject late work. As before, cancellation during active inference
terminates the worker because the pinned SDK has no inference abort mechanism;
normal segment transitions never restart it. The next request can use browser
cached assets. No model work starts without current-visit activation and consent.

Recently handled assistant IDs (bounded to 96 in this mounted controller), consumed
spoken prefixes and a per-request suppression marker prevent completion,
reconciliation and retry from automatically replaying prior speech. Restoration
alone never starts speech. Failed/uncertain streams stop automatic work; manual
Read remains available for a completed saved response and deliberately reads it
from the beginning. Explicit manual playback takes priority over automatic output.

The analyser is attached only during actual audio. Preparation progress cannot
replace a playing state; playback wins orb state arbitration, then existing text
Thinking/Talking, then speech preparation. There are no shader/appearance changes,
per-frame React updates or canvas replacements.

## Validation and limits

`npm test` covers segmentation, Markdown fragments, byte-sized updates, ordered
prefetch, completion/reconciliation duplicates, queue backpressure and cancellation.
`npm run test:voice` verifies that preparation survives a natural audio ending and
next playback start, and that Stop aborts both lanes. Existing analyser tests run
with `npm run test:audio`.

Browser timing uses performance.now, AudioBufferSourceNode start/ended events and
the first non-zero analyser signal. It is an audibility proxy, not a physical audio
latency measurement. Cold timing includes model/runtime download and initialization.
Prefetch reduces gaps only when synthesis finishes before the prior segment ends;
CPU/WASM on slow devices can still leave gaps. Browser/device validation and the
English-language, memory and dependency limitations in voice-engine.md still apply.

### Recorded Chromium sample

Mock SSE delivered “You are connected.”, bold “I am Lain.”, a fenced code block,
and an unfinished final phrase. Nicole spoke the first sentence while SSE remained
open, skipped the fence, and spoke the final phrase only after done. One worker
was reused, including manual replay. No runtime exceptions occurred and the canvas
stayed mounted.

- Cold first source start: 19,526.7ms after the first confirmed sentence boundary.
- Cold first non-zero analyser signal: 19,750ms (includes cold download/init).
- Actual next-segment source start minus prior ended event: 3,836.9ms and 5,573ms.
- The second preparation began 2,180.6ms before the first segment ended.
- Warm manual replay first signal: 10,996.2ms, for the longer combined response.

These utterances differ in length; the cold/warm figures are not an apples-to-apples
speedup benchmark. The overlap is verified, but this CPU/WASM environment still
synthesizes more slowly than some short segments play. Physical-device pacing and
an equal-text warm benchmark are the recommended next validation.
