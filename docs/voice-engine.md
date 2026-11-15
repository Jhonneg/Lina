# Client voice engine — Milestone 5E.2

`src/lib/voice/index.ts` exports `createVoiceEngine()`. It can be used independently; main-chat consent and playback are documented in
`chat-voice.md`. Creating an engine starts no model download or audio context. The engine owns its provider, context and playback resources; dispose it
when its consumer unmounts. One playback operation and one optional preparation slot are active per engine.
Normal generate/speak calls cancel earlier work; prepare/play support bounded
prefetch as described in `progressive-speech.md`.

```ts
import { createVoiceEngine } from "@/lib/voice";

const voice = createVoiceEngine({ onStateChange: state => console.log(state) });
// In a click/tap handler (before any unrelated await):
await voice.speak("You are connected. I am Lain. What shall we explore today?", {
  onProgress: progress => { /* loading file/percent, or generating */ },
}); // Resolves when playback starts; state changes back to idle when it ends.

voice.setVolume(0.6); // 0–1, independent of the reference's 0.75 master gain
const analyser = voice.analyser; // AnalyserNode during playback; null afterwards
voice.stop(); // Cancel loading/generation/playback, drop late results, disconnect
await voice.dispose(); // Also terminate worker and close AudioContext
```

For separate generation/playback, call `generate(text, {signal, onProgress})` to
receive an AudioBuffer without starting playback. Call `unlock()` from a user
gesture before preparing speech for later playback, or call `play(buffer, signal)`
from a gesture. Both `speak` and `play` attempt AudioContext.resume; blocked/suspended
playback returns a recoverable `VoiceError` with code `autoplay`. The resume wait
is bounded to three seconds and cancellation releases it. No silent browser-TTS
fallback is used. Speech text is bounded to 4,000 characters per operation; callers
must deliberately split longer passages in a later integration.

## Canonical settings and effects

The approved source is `docs/references/lain-vocal-interface-lab-v3.html`, preset
**Ethereal Companion · Refined**. `refined.ts` retains the exact processing:

- Nicole `af_nicole`, `kokoro-js@1.2.1`, model
  `onnx-community/Kokoro-82M-v1.0-ONNX`, q8/WASM, speech speed 0.95.
- 65Hz high-pass → 190Hz low shelf (+4.5dB) → 2700Hz peaking EQ (Q0.8, −1dB).
- Dry/ring-modulation mix 91%/9%, sine carrier 68Hz, ring gain baseline zero.
- Deterministic stereo 0.45s convolution impulse, seeds 17/48, original LCG,
  cubic decay and 0.3 scale; direct/reverb mix 92%/8%.
- Compressor threshold −19dB, ratio 2.5, attack 0.004s, release 0.12s; other
  compressor and convolver defaults unchanged. Reference master gain 0.75.
- Pitch/playback rate `2 ** (-1.2 / 12)` with 0.04s target ramp; the reference's
  gain/carrier targets retain 0.035s ramps and oscillator starts at 46Hz.
- Output analyser FFT2048, smoothing0.65. `drive: 1.35` remains available in
  REFINED_PRESET as future analysis sensitivity, without changing audio gain.

The source WAV conversion and AudioContext.decodeAudioData path are retained.
There is no additional effect or limiter. Volume adds a unity-default gain before
the analyser, so volume1 preserves reference output. Natural completion stops
and disconnects the graph, including its reverb tail, as the reference does.

## Lifecycle, downloads and compatibility

A lazily constructed module Worker imports Kokoro and initializes the model once;
subsequent successful generations reuse it. WAV bytes are transferred back to the
main thread; Web Audio performs decoding and effects. No per-frame React updates
or analysis/rendering loop is added. A provider implements `SpeechProvider` to
replace neural generation independently of playback and effects.

Cancellation deliberately terminates the worker to interrupt both loading and
inference (the pinned SDK has no inference AbortSignal). A subsequent generation
creates a fresh worker and reloads the model, using the browser HTTP/Cache Storage
cache when available. This differs from the lab's discard-only cancellation.
`pagehide` stops work; `dispose()` also frees the model and closes the context.
No arbitrary-text audio cache is retained. The lab's fixed sample cache, upload
mode, offline Flite fallback, preset sliders and waveform/orb UI are not ported.

The [q8 weights](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/main/onnx) are about 92.4MB;
[Nicole voice data](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/main/voices) adds about 522kB, plus tokenizer/config,
JavaScript and WASM runtime downloads. Model weights are fetched at runtime and
never included in Git. Cached downloads are browser-managed and may be evicted.
Cold start, memory use and synthesis latency depend on the device; WASM inference
still consumes CPU and substantial RAM even in a worker. There is no WebGPU or
multithreading requirement added by this engine.

Use a modern browser with Web Audio, module Workers, WebAssembly and AbortSignal.any
on HTTPS or localhost, with access to Hugging Face model files and the runtime's
WASM assets. Chromium is the primary verification target; Safari/Firefox and
physical mobile devices require follow-up checks. Autoplay permissions, CSP,
network access, memory limits and background-tab suspension can prevent playback.
Nicole is an American English voice; this integration makes no multilingual
pronunciation guarantee. It does not substitute another voice for other languages.

Some Linux installations with global libvips/CUDA require the following supported
install-only switches for unused Node paths in the browser SDK's dependencies:

```sh
SHARP_IGNORE_GLOBAL_LIBVIPS=1 ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci
```

These do not change browser synthesis settings. `npm run test:voice` uses isolated
fake worker/Web Audio fixtures and compares DSP parameters and impulse samples
against the approved HTML; it never downloads weights or calls paid services.

The installation audit reports three high-severity findings along the
kokoro-js → Transformers.js → sharp chain, concerning sharp's native image
libraries. This engine uses browser audio/WASM, not that Node image-processing
path. The audit provides no compatible automatic fix; the approved SDK remains
pinned. Review the dependency chain before production rather than blindly applying
`npm audit fix --force` or silently upgrading the approved voice implementation.

Verification in this environment: headless Chromium loaded the real q8 model,
synthesized the approved Nicole phrase and produced a non-zero Web Audio analyser
signal. A separate synthetic tone exercised playback, volume, stop and disposal.
This verifies execution, not a subjective listening comparison or physical-device
performance. Safari/Firefox/mobile and an audible reference comparison remain to
be checked before wiring the engine to the interface.

`prepare(text, options)` returns audio without interrupting playback; only one
preparation may be active. `play` and natural audio endings preserve that slot.
`stop`/`dispose` cancel both. The progressive controller keeps at most one upcoming
audio segment and reuses the same provider/model.
