# Milestone 1 — Original panel 02 port

Superseded by the [approved HD Subtle integration](orb-hd-subtle-integration.md). This document records the earlier panel 02 port; the current implementation uses the newer approved geometry, shading, clock and shell opacity.

Authority: `docs/references/LAIN_ORIGINAL_ORB_SOURCE_GUIDE.md` and panel 02 in `docs/references/lain-three-prototypes-amber.html`. This port replaces the earlier image/video approximations.

## What is ported

- `shaders.ts`: original vertex and fragment shader text, with whitespace formatting only. All numeric coefficients and formulas are retained, including the three multiplied position-based sine waves, detail sine, UV grid, Fresnel term, alpha and palette. No extra noise, wave packets, crest limit, barycentric lines, speech envelope or shader output chunks remain.
- `orb-geometry.ts`: original surface `SphereGeometry(1.66, 112, 80)` and undeformed shell `SphereGeometry(1.72, 34, 25)`. Parent presentation scaling preserves local-space positions and therefore the shader's wavelengths.
- `noise-orb.tsx`: surface `ShaderMaterial` is transparent, FrontSide and `depthWrite=false`; the original low-opacity amber wireframe shell uses `MeshBasicMaterial`. Uniforms `time`, `energy`, `pulse`, `glitch` are stable objects updated in `useFrame`. The source's pointer tilt acts on the shared parent, separately from both meshes' rotation. Declarative R3F geometry and materials are disposed on unmount.
- `orb-state.ts` / `orb-animation.ts`: original state targets, update order, easing, pulse scheduling/decay, rotations and shell opacity. No React state updates occur in the frame loop.
- `orb-debug.tsx`: the existing development panel now displays the actual original uniforms and motion fields. The page and chat placeholder were not modified.

| State | Energy target | Pulse interval | Pulse peak before decay |
| --- | ---: | ---: | ---: |
| Idle | 0 | 4s | 0.16 |
| Thinking | 1 | 1.35s | 0.4 |
| Talking | 0.48 | 0.42s | 1 |

The original `Math.min(1, dt * 2.7)` energy easing, `Math.exp(-dt * 6)` pulse decay and 0.05s delta cap are retained. Shader time uses elapsed active time. Pulses use the original strict `t - lastPulse > pulsePeriod` check; `lastPulse` persists across mode switches, as in the source. A shorter new period can consequently trigger a pulse immediately.

The surface rotates by `dt * (0.11 + energy * 0.27)` around Y and `dt * 0.035` around Z. The shell rotates oppositely by `-dt * 0.06` around Y; its opacity is `0.07 + energy * 0.08 + pulse * 0.12`. The source's absolute-time / energy phase formulas are retained rather than replaced with the former independently integrated wave clocks.

## Intentional differences

1. **Compact presentation:** perspective FOV 42° and z=7 match the source; the current 320×300 desktop / 224×224 mobile stage remains in place. A fixed parent scale of 0.94 desktop / 0.86 mobile fits the app. Geometry radii, UVs and shader constants are unchanged. The original four-panel page and its backgrounds are not ported.
2. **Reduced motion:** the app freezes shader time and both rotations and sets energy/pulse to zero. The original stops rotations and zeroes shader energy/pulse but continues its time-driven base deformation. The app also reacts to preference changes at runtime.
3. **Tab pause/resume:** hidden tabs pause rendering; the first resumed delta is skipped so hidden time does not cause a jump or pulse burst. The source's raw clock can include that hidden interval. Ordinary visible-frame update math, including its 50ms cap, is otherwise preserved.
4. **Existing runtime:** the app retains Three.js 0.187.0 / R3F rather than adding the original CDN's Three.js 0.160.1. The renderer uses no tone mapping, matching the original WebGLRenderer default. Existing mobile-aware DPR caps (desktop 1.5 / mobile 1.25) and low-power renderer preference remain, versus the demo's 1.7 DPR cap and high-performance preference.
5. **Optional controls:** no glitch button, auto-cycle toolbar, other prototype panels or backend behavior is added. The exact shader retains its `glitch` uniform, held at zero. The app's existing static fallback and minimal controls remain.

## Executed checks

- `npm run lint`: passed.
- `npm run typecheck`: passed.
- A focused source comparison checked both shader strings against the actual original HTML, ignoring whitespace only, and checked the exact geometry arguments.
- The original HTML's state-loop and panel-update functions were executed as a reference against the port at 15/30/60/120fps, through Idle → Thinking → Talking → Idle. Energy, pulse, last-pulse scheduling, elapsed time, both surface rotations, shell rotation and shell opacity matched exactly per frame. This tests fidelity to the original, not a claim that its capped-delta behavior is identical across different frame rates.
- The original HTML ran in Chromium with its exact Three.js 0.160.1 dependency cached from the source CDN into `/tmp`. A browser-only inspection hook set matching time/energy/pulse, rotations and presentation scale for comparison; the repository's reference HTML was not modified. Original and port renders were visually inspected for all three states: [source comparison](reviews/noise-orb-original-source-comparison.png).
- Browser checks confirmed GPU/material uniform agreement, all three state targets, independent shell rotation/opacity, no shader or console errors, identical reduced-motion captures (including state selection), and no horizontal overflow on mobile. Raw results: `/tmp/lain-original-source-browser-results.json`.
- Captured diameters: desktop Idle 188–200px / Thinking 201–226px / Talking 197–234px; mobile Idle 127–135px / Thinking 136–151px / Talking 133–152px. These are sampled windows, not an added shader displacement clamp.
- `npm run build`: attempted; still blocked by the existing Turbopack CSS worker port-binding restriction (`Operation not permitted`, OS error 1). Complete output: `/tmp/lain-original-source-build.log`. No configuration workaround was applied.

Run `npm run dev` and use the existing Idle / Thinking / Talking buttons. Idle has small pulses every four seconds; Thinking increases wave speed and displacement with 1.35-second pulses; Talking has the original fast 0.42-second pulse train. Expand **Orb animation debug** to inspect the source uniforms and shell motion.

Review the port locally against panel 02 before any further milestone. Physical-device performance still needs review; the source comparison uses software WebGL.
