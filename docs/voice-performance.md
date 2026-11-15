> Historical benchmark record: Milestone 5F.5 removed the local neural runtime and
> `/dev/voice-benchmark` route. The measurements and JSON results below are retained
> as evidence, not current setup instructions. External benchmark profiles/caches
> were not removed. Current voice uses [cloud speech](cloud-chat-voice.md).

# Voice performance recovery — Milestone 5E.6

## Measured benchmark — 14 November 2026

The following measurements were collected before pipeline changes. Raw measurements are in `voice-benchmark-results.json`.

### Scope and hardware gate

Isolated temporary application copy; no repository implementation or production backend changes. Approved FP32 model download occurred only after Chromium returned vendor `nvidia`, architecture `turing`, and `isFallbackAdapter: false`. CDP confirmed ANGLE Vulkan on NVIDIA GeForce GTX 1660 SUPER, driver 615.78.8.0. NVIDIA reports 6,144 MiB VRAM. The initial SwiftShader probe was excluded.

Production dependencies were reused unchanged: kokoro-js 1.2.1, model onnx-community/Kokoro-82M-v1.0-ONNX, Q8/WASM versus FP32/WebGPU. One dedicated worker/model at a time, reused across each backend's three trials. No additional model formats downloaded. Weights remain in a temporary browser profile outside Git.

## Method

Identical English input in all trials:

> You are connected. I am Lain. We can explore the quiet patterns of thought, one idea at a time.

Nicole (`af_nicole`), speed 0.95. The existing VoiceEngine, WAV conversion/decode, and unchanged createRefinedGraph/createRefinedImpulse supplied playback, including pitch -1.2 semitones and all approved filtering, modulation, reverb, compression, and gain settings. The existing HD orb rendered in the same page throughout.

Each backend had one fresh initialization and two same-model warm trials, sequentially. Inference is the elapsed public `tts.generate()` call, including phonemization/tokenization and provider work; it is not isolated ONNX-kernel timing. RTF = generate milliseconds / raw audio milliseconds. Warm runs exclude model download/initialization. First audio means the first non-zero post-DSP analyser signal, not measured physical speaker latency. The harness explicitly enabled audio; production consent/autoplay behavior was untouched.

| Metric | Q8/WASM | FP32/hardware WebGPU |
| --- | ---: | ---: |
| Initialization including fresh model download | 9.162 s | 30.714 s |
| Cold inference | 20.993 s | 2.888 s |
| Cold first audio signal | 30.696 s | 34.049 s |
| Warm inference 1 | 20.230 s | 1.479 s |
| Warm inference 2 | 20.150 s | 1.402 s |
| Mean warm inference | 20.190 s | 1.441 s |
| Generated raw audio duration | 10.425 s | 10.475 s |
| Warm RTF range | 1.933–1.941 | 0.134–0.141 |
| Mean warm RTF | 1.937 | 0.138 |
| Mean warm first audio signal | 20.450 s | 1.703 s |

Mean warm inference speedup: **14.01×**. FP32 and quantized output durations differ by 50 ms; RTF uses each actual output duration. Refined pitch lowering lengthens playback beyond raw duration; RTF is reported against raw generated audio, consistently for both backends.

## Orb/frame observations

The orb used real NVIDIA WebGL via ANGLE Vulkan, rather than software rendering. RAF frame intervals were collected during generation and playback; these are page frame-pacing observations, not isolated GPU timer queries.

- Baseline median/p95: 16.7/16.8 ms.
- Warm WASM trials: median/p95 approximately 16.7/16.7 ms; no intervals over 50 ms.
- Warm WebGPU trials: median 16.7 ms, p95 16.7–16.8 ms; no intervals over 50 ms.
- Cold WebGPU trial: 11 intervals over 50 ms across initialization, generation and playback. Their exact attribution was not isolated. No claim of stall-free initialization.

No sustained warm orb frame-pacing degradation was observed in this small sample. This is not a mobile, integrated-GPU, visible-display, or long-session validation. The page used the existing Talking baseline; it did not run the full chat/audio-reactivity lifecycle.

## Memory

`nvidia-smi` sampled total device memory every approximately one second: initial 733 MiB; observed minimum 614 MiB; peak 1,896 MiB; final sample 730 MiB. Peak minus initial is 1,163 MiB (~1.14 GiB). Other desktop applications shared the GPU, and model tensors were not independently accounted; do not interpret this as exact model VRAM. Brief peaks could be missed by the sampling interval. A second phase-correlated sampling helper lost its final data when the browser closed; only the completed primary memory trace is reported.

The page's exposed JS heap estimate was 86.4 MB, unchanged across trials. It does not account for worker/WASM/GPU memory and is not a model-memory metric.

## Findings and recommendation

On this hardware, current Q8/WASM generation is slower than playback. Queue scheduling alone cannot sustain uninterrupted speech indefinitely with RTF near 1.94. Hardware FP32/WebGPU provides substantial synthesis headroom, at the cost of a larger download, higher GPU memory pressure, and observable cold-phase stalls.

Recommend a separately reviewed WebGPU-with-WASM-fallback experiment, gated by actual hardware capability and explicit variant-download consent. This result does not justify automatically changing production, nor does it establish compatibility or quality on other devices. Keep production on Q8/WASM for now. Server inference is not necessary to explain this machine's warm performance, but may remain relevant for devices lacking adequate GPU acceleration.

At the benchmark checkpoint, missing speech remained a separate investigation: code inspection found conservative Markdown blocking and prefix-reconciliation termination paths. The implementation below addresses these paths; the equal-text benchmark itself did not test or fix them. Progressive queue underruns, segment coverage, worker cancellation/restart counts, long-response behavior, and comparative listening quality remain unverified in this isolated equal-text benchmark.

## Artifacts and validation

- Raw results and total-device memory trace: /tmp/lain-voice-hardware-results.json
- Hardware/driver/WebGL/WebGPU diagnostics: /tmp/lain-benchmark-gpu-system.json
- Temporary benchmark app: /tmp/lain-progressive-app-6F57Ta
- Browser runner: /tmp/lain-voice-hardware-benchmark.mjs
- Model browser cache: /tmp/lain-voice-hardware-profile-xLuxSJ

Six real synthesis/playback trials completed (three per backend). Browser and temporary Next server were stopped. No model weights were added to Git. No paid APIs, migrations, or builds. This benchmark preceded the implementation below.


## Implemented recovery

- `speech-segmenter.ts`: literal intraword underscores, multiplication, comparisons and pipes no longer block the remaining response. Final incomplete emphasis and link labels are retained without reading destinations or formatting. Open fences/inline code remain excluded. The final whole-word portion of the 4,000-unit budget is retained. A changed already-spoken prefix now produces an explicit recoverable notice instead of silently dropping the remainder; it stops rather than risking duplicate speech. Manual Read can replay the final saved text.
- `VoiceEngine.enqueue`: schedules at most two sources (current plus next) using `AudioContext.currentTime`. Next audio no longer waits for a JavaScript `ended` callback to start. The duration calculation accounts for the exact Refined exponential pitch ramp. Buffers share the Refined graph/analyser across continuous playback. Settings and formulas remain unchanged; oscillator/reverb continuity now follows the response rather than restarting per segment. Existing `play`/`speak` remain compatible.
- Controller: begins synthesis as soon as text is eligible, reuses the one initialized worker/model, schedules the next decoded segment ahead, and can retain one further prepared buffer. This bounds audio to three segments (two scheduled, one preparing/ready), plus eight queued text segments and the existing bounded source text. No extra startup prebuffer delay is introduced. Underruns resume as soon as audio is ready; this cannot solve sustained RTF > 1.
- Stop, new submissions, navigation, reset, disable and disposal continue to abort the job. Scheduled sources, ready audio, and queued text are discarded; late synthesis/completion callbacks cannot play. Active uncancellable inference still requires worker termination on cancellation. Natural segment transitions never restart the worker.

## Development diagnostics

`window.__lainVoiceDiagnostics` is a development-only ring of at most 1,000 events. It stores timings, lengths, counts and flags, never text or credentials. Clear with `window.__lainVoiceDiagnostics.length = 0`; reload to clear worker lifecycle counters. Events include:

- `job-started`, `segment-eligible` (time to first eligible segment, index, length).
- `worker-started` / `worker-terminated` / `inference-cancelled` (restart flag).
- `synthesis` (initialization, generate duration, actual audio duration, RTF, reused-model flag).
- `preparation-started` / `prepared` (decode-inclusive preparation and overlap).
- `segment-scheduled` / `playback-scheduled` / `playback-ended` (time to source, audio-clock scheduling depth and duration).
- `queue-underrun` and the next segment's `waitMs` distinguish inference starvation from text starvation.
- `job-completed` / `job-cancelled` compare eligible/scheduled/completed counts; `speech-prefix-changed` identifies safe reconciliation stops.

The source-start timing is not physical first-audible latency. The browser verification separately samples the analyser as an audibility proxy. Diagnostics make no promise of guaranteed sentence coverage when input is rewritten, code-only, over the limit, or a cancellation/failure occurs.

## Repeatable isolated benchmark

Run `npm run dev`, then visit `/dev/voice-benchmark` (404 outside development). Q8/WASM requires an explicit benchmark click. FP32/WebGPU additionally requires the download checkbox and a positively identified non-fallback hardware adapter. Software/unknown adapters skip the download. The benchmark uses its own worker, one model instance at a time, identical text, Nicole/speed/Refined DSP, one initial and two warm trials, frame timing and first analyser signal. Browser cache can make the initial trial a cached initialization rather than a true cold download; use a separate browser profile for fresh-cache measurements. This route does not change the main voice factory. No paid APIs are used.

GPU memory must be sampled externally (`nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv`) when available; browsers do not provide a reliable portable model-VRAM metric. Headless Chromium on this host needed native Vulkan with software fallback disabled to expose NVIDIA; a successful requestAdapter alone is insufficient proof of hardware.

## Remaining bottlenecks and next decision

Production deliberately remains Q8/WASM. Its measured RTF around 1.94 means audible gaps remain possible even with correct overlap and scheduling. No shorter first-playback claim is made from unequal-text pre/post runs. The supported next experiment is a separately approved WebGPU/fallback rollout, not a silent backend switch. Validate other GPUs, mobile, download consent, cold stalls and voice quality before adopting it. Server-side inference remains an alternative for devices without sufficient hardware.


## Recovery validation

- `npm run lint` and `npm run typecheck`: passed after fixing the checks' reported issues.
- `npm test`: 109 server/chat tests and 7 rendering tests passed.
- `npm run test:voice`: 12 passed, including exact DSP/reference equivalence, model reuse/metrics, adjacent audio-clock scheduling and queued cancellation.
- `npm run test:audio`: 5 passed. Total: **133 tests**.
- One focused Chromium real-Nicole/mock-chat workflow passed with real NVIDIA rendering. It verified speech before SSE completion, code exclusion, final flush including `foo_bar` and unfinished emphasis, three eligible/scheduled/completed segments with no truncation or duplication, overlapping preparation, one worker, manual replay, Stop and the same mounted orb canvas; no runtime exceptions.
- Cached-assets first source/first non-zero analyser: 6,175.8/6,409.2 ms after the first confirmed sentence boundary. Model initialization inside the first request: 1,531.9 ms (excludes worker/runtime import). First generation: 4,046.5 ms for 2.025 s audio (RTF 2.00). Subsequent segments: 3,677 ms/1.85 s (1.99) and 9,225.4 ms/4.4 s (2.10). One worker started, reused normally, then terminated on Stop during manual replay.
- Measured start-minus-prior-ended gaps: 1,425.4 and 7,286.6 ms; diagnostics recorded two inference underruns. Final text was deliberately held until SSE completion, and utterances differ from earlier recordings, so these are not an equal-text before/after speedup claim. Warm manual replay first signal: 7,348.2 ms for a different, grouped passage.
- Scheduling tests verify zero intended gap for buffers available ahead of the boundary. Real WASM trials still ran out of audio; eliminating those gaps requires faster inference or substantially delaying playback to prebuffer more of the reply. This implementation does not hide that tradeoff.

No dependencies, chat/backend contracts, schema, personality settings or orb appearance were changed. No production build or paid API calls were attempted. The production backend remains Q8/WASM. The recommended next task is a reviewed WebGPU-with-WASM-fallback experiment with download consent and broader device/voice-quality validation.
