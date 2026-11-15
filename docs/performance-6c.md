# Performance review — Milestone 6C

## Change and evidence

The only application changes are in `use-chat-voice.ts` and `chat-window.tsx`:

- Stabilize playback activation/read callbacks with useCallback. The read handler
  still resolves the current controller through refs, preserving cancellation and
  user-gesture AudioContext activation.
- Pass the transmitting flag only to the actively streaming row. Completed/user
  rows no longer receive irrelevant phase changes.

Previously every text delta and voice lifecycle update supplied a new onRead
function to every memoized ChatMessage, defeating row memoization. Stable props
now let unchanged history rows bail out. No updates were throttled, no deltas were
batched/dropped, and the active Markdown response still updates progressively.
The approved orb, audio DSP/player, preset, personality and all server/security
sources were preserved; source hashes are recorded in the summary artifact.

## Measured results

Same instrumented development workload, three fresh page trials per version,
three responses per trial (nine responses/version), each starting with 40 saved
messages. Synthetic SSE chunks arrive every 35ms; synthetic PCM arrives in 100ms
blocks every 40ms. Voice uses the real approved DSP/playback/analyser code but
**not real OpenAI speech**. All API requests are mocked before hydration. An
isolated copy has blank API/database credentials and no environment files.

Means across the nine responses unless otherwise stated:

| Metric | Before | After |
| --- | ---: | ---: |
| ChatMessage committed performed-work events/response | 4,748 | 78 |
| Active Markdown performed-work events/response | 75 | 75 |
| Chromium main-thread ScriptDuration | 894.7ms | 685.6ms |
| Chromium main-thread TaskDuration | 1,146.0ms | 935.1ms |
| LayoutDuration | 22.8ms | 22.2ms |
| Mock response/playback wall time | 4,343.7ms | 4,348.2ms |
| p95 rAF interval during responses | 16.73ms | 16.76ms |
| Idle rAF frequency | ~60fps | ~60fps |
| WebGL draw calls/frame | 2 | 2 |
| Sustained hidden/reduced-motion draw calls | 0 / 0 | 0 / 0 |
| Decoded development JS loaded through the workflow | 9,173,600 bytes | 9,174,466 bytes |

Row work fell **98.4%**, ScriptDuration **23.4%**, and TaskDuration **18.4%**
in these instrumented runs. There is no demonstrated wall-time, frame-rate, bundle
or memory improvement. The fixture's pacing controls wall time; frame differences
are within ordinary noise. CPU figures include instrumentation, development React,
synthetic transport, R3F and DSP work. They are not production speedup guarantees.

React work is counted from committed PerformedWork flags with bailed-out shared
child subtrees excluded; it is not a count of production function invocations or
Strict Mode's extra invocations. CDP timing counters are collected independently
from those event counts. No compiler/test commands ran during the paired samples.
The final raw reports use the same corrected recorder for both versions.

## Orb, GPU and rendering review

Chromium reported hardware NVIDIA rendering via ANGLE/Vulkan: GTX 1660 SUPER,
driver 615.78.8.0. Host CPU: Ryzen 5 5600G, 12 logical CPUs. Browser:
HeadlessChrome/158.0.8127.18; viewport 1440×900, deviceScaleFactor 2. This is one
headless desktop configuration, not a physical mobile or battery benchmark.

Measured canvas: 360×350 CSS pixels, 540×525 backing pixels (effective DPR 1.5).
Per rendered frame: 54,912 triangles plus 13,776 shell line primitives, two draws,
and eight live WebGL buffers. Geometry remains the approved 192×144 surface and
56×42 shell (30,436 vertices combined, calculated from those segment descriptors).
No resolution, material, shader, geometry or animation changes were justified.
GPU timer-query duration, utilization and per-process VRAM were not measured;
frame rate and primitive counts do not establish GPU utilization or power draw.

Source review confirms mobile DPR remains capped at 1.25; desktop at 1.5. Mobile
performance was not measured. Visible Idle intentionally keeps rendering because
its approved rotation/waves are continuous. Hidden visibility handling and actual
reduced-motion media emulation both reached zero sustained draws. The hidden case
simulates document.hidden plus visibilitychange; it does not measure OS tab
throttling. The recorder's own rAF sampling continues in that simulation.

## Audio and memory

Every trial exercised nine progressive synthetic speech segments over three chat
responses with the unchanged Lain robo DSP. Peak simultaneously scheduled sources
were 20–21. All sources drained; Stop/disable closed the reusable AudioContext.
Final samples had zero active sources, zero open audio contexts, one canvas and
eight persistent geometry buffers. All six final trials reported no uncaught
browser exceptions.

After forced GC, JS heap started around 12.0–12.2 MiB and ended around 15.1–15.4 MiB
after three responses, with roughly 3.1–3.2 MiB growth in both versions. Each trial
retains six additional message rows and loads code highlighting. Backing storage
grew about 0.23 MiB. Similar end-state sizes across fresh trials and drained audio
resources provide no evidence of an audio-resource accumulation in this workload;
this short test **cannot prove absence of long-session leaks** or explain every
retained allocation. No memory optimization is claimed.

Source review: 2,400-sample preallocated PCM staging buffer, 100ms audio blocks,
60-second/2.88MB raw PCM bound, scheduled-source/gain collections cleared on reset,
DSP nodes/oscillators disconnected, and context reuse until disable/unmount. The
lab retains one bounded dry take; cloud queues stay within the existing
800-character/three-segment limits. No provider/model assets were downloaded.

## Bundles and remaining bottlenecks

The measured ~8.75 MiB is **decoded development JavaScript across the complete
workflow**, including Next development machinery, not initial production JS or
compressed transfer. There were 27 JS resource entries per trial. No production
build/analyzer was attempted because the previously documented build restriction
remains outside this task. Production bundle size and its split opportunities
remain unmeasured; no reduction is estimated from development resource sizes.

Orb code is already dynamically imported, and code-language highlighting is lazy
and skipped during streaming. Shared Markdown parsing/voice segmentation remains
on the client; the live row still parses changing text. History still renders its
loaded rows rather than virtualizing them. These are potential future targets
requiring a production trace/large-history measurement before further changes.
Real cloud latency, network underruns, long-session memory, physical mobile GPUs,
thermal/power behaviour and production CSP/bundle performance remain unmeasured.
Do not infer real speech latency or gap measurements from the synthetic tone.

## Reproduction and artifacts

Requires an existing Chromium/headless-shell binary and the existing dependencies;
no browser/model install is performed. Run in one terminal:

```bash
node scripts/performance-preview.mjs
```

This makes a temporary source snapshot, excludes .env files, blanks API/database
credentials and starts port 3160 without touching an existing dev server. The
snapshot's temporary Turbopack root accommodates its node_modules symlink; no
production config is altered. Ctrl+C stops this preview. Browser profiles and
snapshots are task-owned temporary artifacts; personal caches/previous benchmark
artifacts are not removed.

In another terminal:

```bash
CHROMIUM_PATH=/path/to/chrome-headless-shell node scripts/benchmark-client.mjs after
```

The recorder uses local CDP port 9245, mocks API requests before page hydration,
blocks provider/model domains and uses synthetic audio. It never initializes real
Kokoro or calls a speech provider. For another paired comparison, take the baseline
snapshot before changing application code, then repeat on the candidate with the
same recorder/environment. Labels determine the output filenames; back up reports
before intentionally rerunning them.

- `performance-6c-baseline.json`: original callback/row props.
- `performance-6c-after.json`: optimized callback/row props.
- `performance-6c-summary.json`: aggregates, invariant assertions and source hashes.
- `scripts/benchmark-client*.{mjs,js}`: mock workload and recorder, outside app bundles.

## Validation

Lint and typecheck passed once after the application change. The corrected browser
recorder was linted separately. Existing suites passed: 109 regression tests,
39 cloud-voice, 5 audio, 2 reference DSP, 3 API-abuse and 4 usage tests (**162**).
Final metric assertions verified unchanged draw primitives/resolution/buffers,
zero hidden/reduced draws, drained audio, no browser exceptions and preserved orb,
DSP/preset, personality and security source hashes. No database was queried or
mutated; no billable requests, dependency changes or production builds occurred.
The isolated profiling server/browser processes were stopped; the user's existing
server was left alone. Public production voice remains disabled.
