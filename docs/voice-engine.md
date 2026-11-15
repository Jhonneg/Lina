# Voice engine and shared audio

Milestone 5F.5 removed the unused Kokoro inference pipeline: providers, neural
workers, model downloads, encoded-audio engine, old chat controller, and the
`/dev/audio-orb` and `/dev/voice-benchmark` local previews. No local models are
bundled or fetched by the application. There is no local inference fallback.
Personal browser caches and external benchmark artifacts were left untouched.

Current speech uses the [cloud adapter](cloud-chat-voice.md),
[progressive PCM playback](progressive-cloud-speech.md), and the preserved
[voice design lab](cloud-voice-lab.md) at `/dev/cloud-voice`.

The approved `docs/references/lain-voice-preset.json` remains unchanged, as do its
server-owned delivery instructions, Shimmer voice and custom DSP. The shared
`src/lib/voice/refined.ts` retains the original Refined comparison graph, filters,
modulation, deterministic reverb impulse, compression, gain and pitch formulas.
Its historical Nicole/speed metadata is reference provenance only; it loads no
model and is not the selected cloud voice. `src/lib/cloud-voice/design-dsp.ts`
reuses this graph for the approved custom preset and the lab comparison controls.

Both PCM players, audio analysis, speech Markdown helpers, and development-only
bounded numeric diagnostics remain. No orb implementation was modified.
`npm run test:voice` now runs only the retained DSP/reference-equivalence tests;
cloud lifecycle, ordering and cancellation tests use `npm run test:cloud-voice`.
`npm run test:audio` covers the shared analyser. Old neural-only tests were removed,
while shared spoken-text conversion tests remain in the regression suite.

See [legacy cleanup](legacy-voice-cleanup.md) for dependency audit results and
[usage protection](api-usage-protection.md) for session, quota and budget controls.
Public production cloud speech remains disabled. Historical inference evidence is
retained in [voice-performance.md](voice-performance.md) and its JSON results.
