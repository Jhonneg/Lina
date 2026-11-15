# Mobile responsiveness and accessibility — Milestone 6D

## Necessary changes

- The history drawer now tracks visualViewport height/offset without per-frame
  React state. Its list scrolls above a keyboard rather than remaining a full
  layout-viewport height behind it; listeners are removed on unmount. Zoomed
  viewports retain CSS sizing instead of following visualViewport scaling.
- Voice settings have a scrollable height bound that reserves header and safe-area
  space. Longer disclosures/controls remain reachable in short viewports.
- Added viewport-fit=cover and safe left/right padding for the chat/drawer. Existing
  dynamic viewport sizing, bottom/top safe padding and keyboard resize logic remain;
  the compact header no longer discards its top safe inset.
- Coarse-pointer header icons, drawer actions, copy/read controls, volume range,
  composer and related buttons now have at least 44px target height; small icon
  controls also have 44px width. Desktop control dimensions/35%–65% layout remain.
- Fixed the composer's aria-describedby referencing a nonexistent preview notice.
- Increased opacity of existing theme colors for low-contrast dates, code comments,
  the composer boundary and scrollbars. No new palette or decorative effect.

No changes to orb geometry, shaders, dimensions, animations, Lain robo/DSP,
personality, streaming/persistence behaviour, backend guards or public voice gates.

## Browser measurements

Headless Chromium 158, touch/mobile device metrics at DPR 2, native touch/key events,
mock session/history APIs, synthetic PCM through the actual approved DSP/player.
The preview is a temporary source copy with no environment files and blank API/DB
credentials. No API request reaches a real provider or PostgreSQL.

Both welcome and active layouts were checked at the five requested widths. Active
conversation results after fixes (CSS pixels; heights rounded for display):

| Viewport | Page scroll width | Message-region height | Composer bottom |
| --- | ---: | ---: | ---: |
| 320×740 | 320 | 274 | 740 |
| 375×812 | 375 | 346 | 812 |
| 390×844 | 390 | 378 | 844 |
| 768×1024 | 768 | 544 | 1024 |
| 1440×900 | 1440 | 684 | 900 |
| 768×375 landscape | 768 | 145 | 375 |
| 844×390 landscape | 844 | 160 | 390 |

No page-level horizontal overflow was measured before or after. Long code and
wide tables scroll within their own regions at narrow widths. Header controls
remained inside the viewport. Composer bounds stayed within all sampled viewports.
Bounds were sampled after transitions settled; this is not a production CLS or
full text-zoom/reflow audit. The existing fixed orb frame and mount-only message
entrances remain; no canvas-remount/layout architecture changes were introduced.

### Keyboard and safe-area simulation

At 390×844, visualViewport was overridden to height 280 and offsetTop 40, representing
an obscured/panned keyboard viewport with a visible bottom at 320:

- Composer bottom stayed at 320; textarea bottom 297, height 44 (previously40).
- Drawer changed from top 0/bottom 844 to top 40/bottom 320, height 280. Close was focused
  on opening, with remaining history content in the scrollable list.
- Voice panel changed from top 98/bottom 404 (clipped below the visible bottom) to
  top 102/bottom 272, with scrollable content 348px inside a 168px client area.
- In a separate native Chromium safe-area override at 844×390 with left/right 44
  and bottom 21, main padding changed 40→44 and drawer header padding 20→44; footer
  padding remained 21. Metadata now includes viewport-fit=cover. Top/bottom CSS
  environment handling is preserved, but physical notch/keyboard combinations
  still require device testing.

These are **browser emulations**, not observations of a real software keyboard,
Safari viewport panning or a physical notched display.

## Touch, focus and audio results

The focused workflow verified opening history with touch, pagination, modal initial
focus, Shift+Tab containment, contextual-menu focus/Escape return, Escape restoring
the opener, and selecting another conversation through the existing URL flow.
Existing menu arrow/Home/End and backdrop handling were source-reviewed; this run
is not an exhaustive keyboard matrix.

A trusted emulated touch on Read activated native Web Audio without an autoplay
bypass flag, played synthetic PCM using the approved effects, then Stop cancelled
active work and Disable closed the context. The existing orb canvas node remained
the same across these interactions. This verifies Chromium activation and resource
lifecycle, not cloud pronunciation, physical speaker audibility or iOS behaviour.
Reduced-motion media emulation produced zero sustained WebGL draws. Forcing WebGL
context creation to fail produced the existing static preview while the composer
remained usable. No uncaught exceptions were recorded.

The Chromium accessibility tree exposed the composer as a textbox named “Message
Lain”. Native labels, dialog/menu semantics, visible focus outlines and help-ID
references were reviewed. This is **not screen-reader listening verification**:
VoiceOver, TalkBack and NVDA announcement order/streaming verbosity remain to test.

## Calculated contrast

sRGB relative luminance after compositing CSS alpha colors over their defined
backgrounds; these are calculations, not screenshot pixel measurements:

| Element | Before | After |
| --- | ---: | ---: |
| History date on plum | 4.22:1 | 5.16:1 |
| Code comment on code background | 4.25:1 | 5.23:1 |
| Composer border against composer background | 1.59:1 | 3.37:1 |
| Conversation scrollbar thumb against plum | 1.76:1 | 3.42:1 |

Gold text on plum is 7.34:1; cream text 14.64:1. The adjusted normal text exceeds the
[4.5:1 text threshold](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html),
and adjusted control cues exceed the
[3:1 non-text threshold](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).
Coarse controls use 44px targets as an ergonomic choice beyond the
[24px AA minimum and its exceptions](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
Disabled controls/decorative borders and inline links are not claimed to share
those target/contrast requirements. This targeted review is not WCAG certification.

## Files and validation

Changed: layout viewport metadata; ChatInput help reference; drawer viewport
subscription; chat/history/voice/Markdown CSS. Added a composer help-ID regression
test, the responsive workflow/probe, raw viewport/inset/contrast JSON and this guide.
The approved-source hashes from 6C remained unchanged.

- Lint and typecheck passed once.
- Regression: 102 server/chat/security + 8 rendering/accessibility tests passed.
- Cloud voice 39, audio analysis 5, reference DSP 2 tests passed (156 total).
- Before/after matrix recorded once; interaction checks were rerun after correcting
  automation assumptions about opening transitions and history refresh pagination.
  No repeated screenshot comparisons or exhaustive browser sweeps.
- No billable calls, database mutations, dependency changes or production builds.
  The isolated preview/browser processes were stopped; the user's server stayed.
  Public production voice remains disabled.

Artifacts: `responsive-6d-results.json`, `responsive-6d-safe-area.json`,
`responsive-6d-contrast.json`. `scripts/review-responsive.mjs` reuses the credential-
free preview (`node scripts/performance-preview.mjs`) and browser fixture from 6C.
With an existing Chromium binary:

```bash
CHROMIUM_PATH=/path/to/chromium node scripts/review-responsive.mjs
```

Default runs the current/after matrix and interactions. REVIEW_COMPARE=1 records
before/after during implementation and pauses on a task-owned continuation file;
REVIEW_ONLY_INTERACTIONS=1 reruns only the interaction portion using an existing
matrix artifact. The optional `review-responsive-insets.mjs before|after` probes
the same open CDP browser during that pause. Back up JSON artifacts before reruns.
No models/browsers/dependencies are installed by the workflow.

Recommended next validation: physical iPhone Safari/VoiceOver and Android
Chrome/TalkBack in portrait/landscape, real keyboard open/close/pan, pinch zoom,
large text, safe insets, audio interruption/lock-screen and slow network behaviour.
No physical devices or additional browser engines were available in this review.
