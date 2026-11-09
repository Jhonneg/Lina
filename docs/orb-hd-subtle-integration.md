# Milestone 1 — Approved HD Subtle integration

Authoritative reference: `docs/references/lain-noise-orb-hd-subtle.html`. The effect is integrated directly into the existing React Three Fiber components; the HTML is not embedded. No dependencies, chat functionality, theme or page layout changes were introduced.

## Files and behavior

- `src/components/orb/shaders.ts`: copies both reference GLSL strings exactly, including the multiplied-sine vertex displacement and derivative-antialiased HD grid. `refinement=1` selects the softer amber palette, restrained highlights and lower translucent alpha. No extra shader effects or postprocessing were added.
- `orb-geometry.ts`: preserves the approved surface `SphereGeometry(1.66, 192, 144)` and separate undeformed shell `SphereGeometry(1.72, 56, 42)`.
- `noise-orb.tsx`: uses DoubleSide / NormalBlending with transparency and disabled depth writes; sets the stable `refinement` uniform to 1; uses the reference's 42° perspective camera at z=7.9. Parent scale is adjusted to preserve the prior compact apparent size without changing local-space shader coordinates. Declarative R3F geometry and material cleanup, pointer easing, client-only loading and fallback remain.
- `orb-animation.ts`: retains reference update order, state targets, energy easing, pulse schedule/decay and independent rotations. The HD reference caps delta **before** advancing elapsed shader time; the port now does the same. Shell opacity becomes `0.032 + energy * 0.045 + pulse * 0.065`, with initial material opacity 0.035. Reduced motion freezes the clock and rotations, zeroes energy/pulse and restores shell opacity to 0.032, matching HD mode.
- `orb-state.ts`: labels and numeric state targets are retained; its source comment identifies the approved HD implementation.
- `orb-debug.tsx`: the existing development panel also displays `refinement`, so the selected HD mode can be verified without adding product UI.

| State | Energy | Pulse interval | Pulse peak before decay |
| --- | ---: | ---: | ---: |
| Idle | 0 | 4s | 0.16 |
| Thinking | 1 | 1.35s | 0.4 |
| Talking | 0.48 | 0.42s | 1 |

Energy easing uses `min(1, dt * 2.7)`, pulse decay uses `exp(-dt * 6)`, and delta is capped at 0.05s. The original last-pulse timestamp is retained across state changes. Surface Y/Z and opposite shell Y rotations follow the reference exactly. All per-frame updates mutate refs/uniforms rather than React state.

## Intentional adaptations

- The reference's large adjustable stage becomes the existing 320×300 desktop / 224×224 mobile canvas. Its new z=7.9 camera is paired with fixed parent scales `0.94 * 7.9 / 7` desktop and `0.86 * 7.9 / 7` mobile. This preserves the previous camera-to-scale ratio and apparent dimensions, while keeping geometry radii and shader wavelengths intact.
- HD mode is fixed on. The reference's Original/HD selector, size slider, FPS counter and optional Glitch button are not added to the minimalist page. The exact shader retains `glitch`, held at zero.
- The existing Three.js 0.187.0 / R3F runtime is retained instead of adding the reference's CDN Three.js 0.160.1. `fwidth` is native in the current WebGL2 renderer, so its obsolete explicit derivatives-extension flag is unnecessary. No tone mapping matches the reference renderer's default.
- Existing DPR caps remain 1.5 desktop / 1.25 mobile, rather than the reference's cap of 2. HD subdivision counts are preserved on both viewports. Physical mobile GPU performance still needs review.
- Hidden tabs use R3F demand rendering and a first-resume delta guard. Runtime reduced-motion changes and the app's touch-scroll behavior remain supported. The standalone HTML's continuous RAF lifecycle and pagehide disposal are adapted to component mounting/unmounting.

## Validation

- `npm run lint`: passed.
- `npm run typecheck`: passed.
- A focused check confirms both shader strings exactly equal the approved HTML, verifies geometry arguments and executes the actual reference animation body against the port at 15/30/60/120fps. Elapsed clock, energy, pulse scheduling/decay, mesh/shell rotations and opacity match per frame, including reduced motion. This checks fidelity to the reference, including its delta cap, rather than assuming identical wall-time behavior across frame rates.
- The approved HTML ran in Chromium using its exact Three.js 0.160.1 dependency cached in `/tmp`. It was compared with the R3F port at matching uniform/rotation snapshots in Idle, Thinking and Talking, with presentation dimensions normalized. See [reference comparison](reviews/noise-orb-hd-subtle-comparison.png). The reference file was not modified.
- Browser checks passed for all three state targets, actual GPU/material uniform agreement, `refinement=1`, independent shell movement, identical reduced-motion captures, no mobile overflow, DPR capped at 1.25 on a simulated DPR-3 mobile display, and context-loss fallback. No shader or console errors were observed. Raw results: `/tmp/lain-hd-source-browser-results.json`.
- Sampled visible diameters stayed compact: desktop Idle 189–201px, Thinking 201–228px, Talking 197–229px; mobile Idle 130–138px, Thinking 135–148px, Talking 134–156px. Measurement thresholds account for the softer HD lines; no shader amplitude clamp or geometry-radius changes were introduced to achieve these sizes.
- `npm run build`: attempted in the sandbox and retried with escalation. Both remain blocked by the existing Turbopack CSS worker port-binding error (`Operation not permitted`, OS error 1). Complete logs: `/tmp/lain-hd-subtle-build.log` and `/tmp/lain-hd-subtle-build-unrestricted.log`. No speculative configuration changes were made.

Run `npm run dev` and use the existing Idle / Thinking / Talking controls to review the integration. The remaining tasks are visual acceptance on local devices, mobile GPU performance review, and a successful build in an unrestricted environment. Stop after this orb integration.
