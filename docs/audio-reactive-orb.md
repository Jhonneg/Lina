# Audio-reactive orb — development preview

Run `npm run dev` and open `/dev/audio-orb`. The route returns 404 outside
`NODE_ENV=development`. It uses the approved HD Subtle orb and existing Nicole
Refined engine. Press **Speak** to load/generate speech; **Stop** cancels and clears
reactivity. The slider changes visual sensitivity only, never voice processing.
Opening the preview creates no speech worker, model download or AudioContext.
Main-chat consent and playback are documented separately in `chat-voice.md`.

`src/lib/audio/reactivity.ts` attaches to an existing AnalyserNode and preallocates
its waveform/frequency buffers. `sample(delta)` mutates one signal object; it
allocates nothing per frame. Bands and normalization follow the V3 reference:

- RMS: `sqrt(mean(sample²))`, gain5 then sensitivity (default1.35), bounded0–1.
- Bass70–250Hz, mid250–2000Hz, treble2000–8000Hz: mean byte-bin energy/255,
  multiplied by sensitivity and bounded0–1.
- A raw RMS noise floor0.002 gates residual FFT noise in silence. Targets decay
  with release rather than snapping on quiet syllables.
- Attack/release use `1-exp(-delta/seconds)`, equivalent to the reference's 0.35/0.12
  at60fps. Constructor/configure options expose both durations, RMS gain, noise
  floor and sensitivity. Suspended contexts/changed FFT size act as silence.

An optional `audioRef` on OrbPresence/NoiseOrb carries this reader. The existing
R3F useFrame calls `applyOrbAudio` to write the four shader uniforms directly;
there are no audio-driven React updates per frame or additional animation loops.
RMS expands the vertex shader by at most4.5%, with the independent shell following
that scale. Bass/mid/treble use the exact V3 normal-displacement wave components
(0.14/0.07/0.035). Added displacement uses remaining headroom inside ±0.68, without
clipping the original no-audio deformation. RMS reduces the simulated pulse by up
to75% to avoid adding a full Talking peak on top of speech. Silence restores the
baseline smoothly. Geometry, fragment colors/transparency, baseline clock,
rotation and state targets stay unchanged.

Stop/error/completion/pagehide dispose the reader and remove its reference;
uniforms reset on the next rendered frame. Unmount clears material audio values.
The reader never disconnects the analyser: the voice engine owns that graph.
Reduced motion disables sampling, zeros audio uniforms, resets shell scale and
retains the approved demand-rendered static orb. Hidden tabs reset rendered audio
values and do not poll the analyser.

The preview includes the existing 250ms DOM-only diagnostic panel, expanded with
actual audio uniforms; per-frame allocation occurs neither in sampling nor uniform
updates. Remove this temporary route/component after the eventual voice UI is
approved. Headless Chromium verification covers actual speech and shader values;
subjective listening/motion review and physical-device performance remain separate.

Validation: `npm run test:audio` covers normalization, band separation,
frame-rate-independent smoothing, noise/silence, buffer reuse, reduced motion and
cleanup; `npm run test:voice` retains reference-DSP and voice lifecycle coverage.
