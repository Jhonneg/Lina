# Chat voice — Milestone 5E.4

The header's **Voice controls** menu enables/disables voice, adjusts volume, shows
loading/generation feedback, and stops speech. Each completed assistant response
has **Read aloud / Stop voice**. Text chat and its errors remain independent.

Voice starts off on every visit. The first activation requires explicit consent
to approximately 93MB of model data plus runtime assets. No model worker or weights
load during ordinary text-only use or merely opening the controls. Consent enables
future downloads, but actual loading starts only when a response is spoken.
Browser-managed HTTP/Cache Storage may reuse model assets across visits; storage
can be evicted. There is no paid speech service or uploaded conversation text.

`lain.voice-preferences.v1` in localStorage stores consent, volume and the prior
voice preference, never session credentials or response text. A previously enabled
preference is remembered in the menu, but a fresh Enable/Read gesture is still
required each visit. Preferences alone do not initialize audio or grant autoplay
permission. Unsupported storage leaves controls functional for the current visit.

`chat-voice-controller.ts` owns one approved engine and one active speech operation.
`use-chat-voice.ts` connects it to React and the existing audio reference. An
explicit click/tap calls unlock synchronously; automatic playback is allowed only
after that activation succeeds. Autoplay rejection is recoverable through **Enable
playback** or a manual Read action. Voice failures show accessible feedback and do
not change text messages or the streaming/persistence lifecycle.

Automatic speech now follows eligible sentences in an observed live request,
with a final flush on completion. Restored history and failed replies do not start
new automatic playback; see `progressive-speech.md` for segmentation and deduplication. Manual Read supports completed previous responses.
Stop invalidates the operation revision, aborts synthesis/playback and prevents
queued chunks or stale activation results from starting. New Chat, conversation
selection, URL navigation, active-conversation deletion, new text submission,
text retry, disabling voice and unmounting use this cancellation path. Disabling
voice/unmounting also dispose the worker and AudioContext. Browser pagehide stops
speech. Enabling voice never automatically reads an already completed reply.

`spoken-text.ts` uses the same unified/remark Markdown parser family already
installed for rich rendering; unified and remark-parse are now explicit direct
dependencies, with no additional packages installed. It skips code/HTML and formats eligible text into bounded, ordered segments.
The 4,000-unit spoken budget remains; one prepared audio segment may overlap
playback, using a single model. Read `progressive-speech.md` for current queue,
Markdown, boundary and cancellation behavior. Legacy spokenResponse conversion
remains available, while the controller uses the incremental SpeechSegmenter.

The approved Nicole q8/WASM settings and exact Refined DSP are unchanged. Nicole
is an English voice; other languages have no pronunciation guarantee. Device CPU,
RAM, network access, browser autoplay rules and cached-asset eviction affect
latency and availability; see `voice-engine.md` for existing platform/dependency
limitations. Volume changes only the engine's existing independent output gain.

During actual playback, an AudioReactivity reader attaches to the existing
AnalyserNode. R3F reads its preallocated buffers through the existing audioRef;
React receives lifecycle/progress events, never per-frame audio updates. Actual audio playback takes priority as Talking; otherwise text Thinking/Talking
is preserved, speech preparation is Thinking, and completion/cancellation returns
to Idle.
Composer submission rules still depend only on text generation, so voice does not
block writing another message. Canvas, orb shader, geometry, palette, baseline
animation and reduced-motion behavior are unchanged in this milestone.

`npm test` includes consent, preference, live-completion, manual playback,
bounded Markdown conversion, cancellation/stale result, error and cleanup tests.
`npm run test:voice` and `npm run test:audio` cover the unchanged engine and analyser.
The Chromium workflow uses mock chat responses and actual Nicole generation,
with no OpenAI calls or development database writes. Physical mobile devices,
Safari/Firefox, audible long-response pacing and offline cache eviction still
need follow-up checks.
