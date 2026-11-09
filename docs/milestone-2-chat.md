# Milestone 2 — Local chat interface

The approved HD Subtle orb now sits inside a responsive conversation shell. This milestone is a local, scripted preview. No API route, model request, authentication, database, storage, real streaming or speech functionality was added, and no dependencies were installed.

## Files

| File | Responsibility |
| --- | --- |
| `src/components/chat/chat-window.tsx` | Owns in-memory messages, draft, simulation phase, timer cancellation and scroll policy. |
| `chat-header.tsx`, `new-chat.tsx` | Lain identity, local-preview label and reset control. |
| `chat-message.tsx`, `chat-types.ts` | Stable message IDs, explicit user/assistant roles and plain-text rendering. |
| `chat-input.tsx` | Labeled form, growing multiline textarea, Enter/Shift+Enter, IME handling, submit availability and local-demo notice. |
| `chat.module.css` | Plum/amber layout, welcome/conversation transitions, responsive message surfaces, focus styles, container-height and reduced-motion rules. |
| `src/components/orb/orb-presence.tsx` | Shared client-only lazy loading and renderer error boundary, memoized so typing does not rerender the orb. |
| `src/components/orb/orb-demo.tsx` | Reuses that wrapper; its manual testing controls are not part of the chat page. |
| `src/app/page.tsx` | Server route renders ChatWindow. |
| `src/app/layout.tsx` | Requests keyboard content resizing through typed Next.js viewport metadata, while leaving zoom enabled. |
| `PROJECT_CONTEXT.md`, `IMPLEMENTATION_PLAN.md` | Record Milestone 1 approval and the user-authorized local functionality in Milestone 2. |

The approved `shaders.ts`, `noise-orb.tsx`, `orb-animation.ts` and `orb-geometry.ts` were not edited. SHA-256 checks against the pre-task versions all pass.

## Local state and orb lifecycle

Messages use `{ id, role, content }`, with UUIDs created outside React state updaters and role explicitly set to `user` or `assistant`. Non-empty trimmed text is appended to React state; internal newlines are preserved. React renders text directly, including angle brackets, without HTML parsing. Refresh discards the conversation.

Sending sets a synchronous pending ref before any state update, preventing same-tick duplicate submissions as well as submissions through the disabled button. The draft clears, focus stays with the composer, and the user can prepare the next draft while waiting.

1. **Idle / Ready:** before sending and after completion.
2. **Thinking:** 900ms simulated processing delay.
3. **Talking / Responding:** one complete, scripted assistant message appears; the approved Talking animation runs for 1600ms.
4. **Idle / Ready:** pending submission lock is released.

There is one active timeout at a time. New Chat cancels it, invalidates the run token, clears messages/draft, restores Idle and focuses the textarea. Unmount also cancels pending work and invalidates callbacks. A previous run cannot change a newly started conversation.

## Layout and scrolling

- **Welcome:** centered compact orb, brief welcome text, bottom composer, no empty bubbles or message panels.
- **Conversation:** the same canvas stays mounted while its frame moves upward and shrinks to the conversation header area. Desktop frame changes from 320×300 to 128×120; mobile from 224×224 to roughly 101×101. Only its presentation dimensions change; shader, camera and animation logic remain approved.
- Frame width/height are animated instead of CSS scaling. Scaling caused the canvas measurement code to apply the size reduction twice; actual dimensions let its ResizeObserver measure correctly. Browser checks confirm canvas/frame alignment after send, reset and viewport changes.
- The header and composer stay in a viewport-height grid. The message log owns the vertical scrolling; long drafts can scroll inside their capped textarea. Page scrolling and horizontal overflow are prevented.
- New messages follow the bottom only while the reader is within 64px of it. Scrolling away preserves the reading position when a reply arrives; Jump to latest returns to the bottom and focuses the log. Sending a new message explicitly returns to the latest content.
- ResizeObserver maintains the bottom position through the welcome transition, composer growth and viewport changes only when pinned. VisualViewport resize/pan handling and container-height queries keep the composer accessible when mobile keyboards cover the layout viewport. Pinch zoom is not disabled.

## Accessibility

The interface uses a semantic header, main, labeled conversation log, message list, form, textarea and native buttons. Sender labels and polite state/message announcements are available without relying on the orb. Keyboard focus is visible; Send keeps focus in the composer, New Chat returns it there, and Jump to latest focuses the log. Enter submits, Shift+Enter inserts a newline, and IME commit events do not send accidentally. Reduced motion disables presentation transitions and the existing orb honors the same preference. Chat remains functional with its static WebGL fallback.

## Executed validation

- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- Browser checks using cached Playwright/Chromium and software WebGL passed for whitespace rejection, IME input, multiline send, duplicate submission prevention, the complete Thinking → Talking → Idle sequence, stable/unique IDs, draft preservation while pending and canvas identity across layout/reset.
- Scroll checks passed: pinned autoscroll, preserving the reader's scroll offset on assistant reply, Jump to latest, and no page scrolling.
- Reset checks passed during both Thinking and Talking, including starting another conversation before an older timer would have finished. No stale callbacks changed the new conversation. Reset clears the draft and focuses the textarea.
- Desktop and 375px mobile views, short keyboard-sized viewports, a mocked visual viewport resize/pan, long draft height limits, 4000-character unbroken text and escaped markup passed. Keyboard focus handoffs were checked separately after their final adjustments.
- Reduced-motion captures were identical over time, CSS transitions were disabled, and messages still worked after simulated WebGL context loss. Refresh cleared messages and draft; no API POSTs or browser errors were observed.
- Sampled visible orb diameters: welcome 190px desktop / 134px mobile, active conversation 86px desktop / 60px mobile. These are representative frames, not new shader limits.
- `npm run build`: attempted; still blocked by the existing Turbopack CSS-worker port-binding restriction (`Operation not permitted`, OS error 1). Full output: `/tmp/lain-m2-build.log`. Build success is not claimed.

## Review locally

Run `npm run dev` and open `http://localhost:3000`.

1. Send a short message; watch Thinking, the complete scripted reply with Responding, then Ready.
2. Try whitespace, Shift+Enter and repeated Enter while pending. Type a new draft during a response.
3. Send enough text to overflow the log, scroll upward, and let a reply arrive. It should not move the reading position. Use Jump to latest.
4. Use New Chat during either pending phase, then start another conversation. Old replies must not reappear.
5. Review desktop/mobile, keyboard access, reduced motion and the layout while the mobile keyboard is open.

Review captures (development tool indicator hidden):

- [Desktop welcome](reviews/milestone-2-welcome-desktop.png) · [Desktop conversation](reviews/milestone-2-chat-desktop.png)
- [Mobile welcome](reviews/milestone-2-welcome-mobile.png) · [Mobile conversation](reviews/milestone-2-chat-mobile.png)

Limitations: replies are canned and arrive as complete messages; messages exist only for the current page lifetime. Physical-device keyboard/screen-reader behavior and mobile GPU performance still need hands-on review. The production build requires verification outside the current restriction. Stop here for Milestone 2 review before implementing any real model or persistence work.
