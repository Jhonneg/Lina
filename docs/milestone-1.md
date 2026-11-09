# Milestone 1 — Noise Orb

The current implementation is the [approved HD Subtle integration](orb-hd-subtle-integration.md). The notes below record earlier implementation stages and do not define the current shader or animation.

Implementation has been revised against `docs/references/NOISE_ORB_SPEC.md` and `noise-orb-target.png` to render an open amber wireframe. No dependencies were added. One scoped Next.js loader correction was required to restore the existing component styles.

The subsequent [animation refinement](orb-animation-refinement.md) documents the verified state flow, independent animation channels and temporary development diagnostics.

## Ownership

- `src/app/page.tsx`: server-rendered header and disabled composer placeholder.
- `src/components/orb/orb-demo.tsx`: temporary controls, status, client-only dynamic import and renderer error boundary.
- `noise-orb.tsx`: Canvas, mutable animation parameters, pointer smoothing, motion preferences, context-loss fallback and capped DPR.
- `orb-state.ts`: typed state presets; later the actual request lifecycle can supply the state prop.
- `orb-geometry.ts`: sphere triangle attributes and barycentric edge coordinates, generated once on mount. Declarative R3F geometry owns their GPU lifecycle.
- `shaders.ts`: GPU noise displacement and antialiased barycentric lines. Face interiors are discarded. Rear geometry remains visible at half the front-line opacity; transparent, double-sided rendering disables depth writes. Brightness is concentrated along ridges without postprocessing or a filled surface.
- `orb-fallback.tsx` and `orb.module.css`: static fallback, restrained glow and responsive presentation.

The orthographic camera targets a base diameter of 200px on desktop and 136px below 640px viewport width. Deformation varies that diameter modestly. Reduced motion freezes continuous animation and pointer response, renders on demand, and retains state labels and static shape changes. Hidden tabs also use demand rendering. R3F owns geometry/material disposal; media-query and context listeners are removed on unmount.

## Local review

1. Run `npm run dev` and open `http://localhost:3000`.
2. Select **Idle**: slow rotation and subtle breathing.
3. Select **Thinking**: stronger surface deformation and slightly faster motion.
4. Select **Talking**: rhythmic pulses. Switch repeatedly to check smooth transitions.
5. Move the pointer across the orb and away; its tilt should ease toward the pointer and back to neutral. Touch scrolling is unaffected.
6. Compare a desktop viewport and a 375px mobile viewport, including resizing between them. Confirm the orb remains secondary to the available content space. The camera zoom explicitly updates at the breakpoint.
7. Enable the system/browser reduced-motion preference: continuous animation and pointer tilt stop, while all controls remain usable. Test the controls with Tab and Enter/Space.
8. Disable WebGL or simulate context loss: a simplified static wireframe and an unavailable notice should appear. The input is intentionally disabled and labeled as a visual preview.

## Validation

- `npm run lint`: passed.
- `npm run typecheck`: passed.
- Browser checks with cached Playwright/Chromium and SwiftShader: all three state controls update correctly; desktop/mobile screenshots captured; reduced-motion screenshots remain identical over time; no horizontal overflow at 375px; context loss produces the static fallback; no browser console or shader errors.
- Captured desktop states measured approximately 201–215px across; the mobile Idle frame measured 139px. Apparent diameter varies slightly with deformation and rotation.
- Visual comparison: reference and Idle render were viewed side by side at comparable size. Tuned mesh density, thinner strokes, warm amber color, quieter rear lines and center, stronger ridge highlights, resting tilt, and bounded silhouette deformation. See [comparison capture](reviews/noise-orb-comparison.png). This is a recreation of the reference, not a claim of identical pixels or original demo source.
- The browser revealed missing CSS module class exports: the existing `*.css` loader with `as: '*.css'` converted the module to global CSS. Restricting the Tailwind loader to `globals.css` restores native CSS module handling, the intended layout and an unclipped canvas. This was an observed styling correction, not a production build workaround.
- `npm run build`: reattempted, including an escalated run; still blocked by Turbopack's CSS worker port bind (`Operation not permitted`, OS error 1). Complete output: `/tmp/lain-wireframe-build.log`. Build success remains unverified.

Visual acceptance and performance on physical mobile GPUs still require user review. The current browser checks use software WebGL. A successful production build is also still required on an unrestricted machine. Stop here for Milestone 1 review before further interface or backend work.
