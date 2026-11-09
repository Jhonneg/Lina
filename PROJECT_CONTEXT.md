Lain 2.0 — Project Context
Status: Milestone 1 HD Subtle orb approved and complete. Milestone 2 local chat interface implemented for review; production build verification remains blocked in the execution environment.
Product vision
Lain 2.0 is a minimalist conversational AI application represented by a living, responsive 3D entity. The orb is a visual companion for a chat interface, not a standalone full-screen 3D art exhibit. The user wants a polished, calm experience with expressive but clean and restrained animation.
Confirmed design choices
- Theme: dark plum + muted gold + amber (same direction as the user's portfolio).
- Approximate palette: background #1C131B; muted gold #C59F60; amber accent #DB924B; light foreground #F4E5CF. These are starting tokens; tweak only modestly for contrast or visual balance.
- Style: minimalist, spare interface, generous whitespace, subtle effects; no heavy glassmorphism, noisy decorations or huge gradients.
- 3D entity: `docs/references/lain-noise-orb-hd-subtle.html` is the approved source. Preserve its original multiplied-sine displacement and timing, 192×144 double-sided HD surface, antialiased subtle amber UV grid, and separate 56×42 low-opacity rotating wireframe shell. This supersedes earlier prototypes and image/video approximations.
- Sizing is an explicit priority: the earlier concept's orb was too big. Target apparent orb diameter 180–240 px desktop, 120–160 px mobile (adjust to available space). The WebGL canvas may be larger/transparent to allow visual glow without making the orb itself oversized.
- Center orb above chat before messages; once a chat is underway, allow it to move higher/become more compact, so conversation text remains primary.
- Three states follow the approved HD source: energy targets Idle 0 / Thinking 1 / Talking 0.48, pulse periods 4s / 1.35s / 0.42s, and pulse peaks 0.16 / 0.4 / 1 before decay. Preserve its capped animation clock, energy easing, pulse timing, independent rotations and subtle shell opacity. Testing controls are temporary, not final product UI.
- Respect prefers-reduced-motion, responsive canvas sizing and mobile GPU constraints.
Technical direction (proposed, subject to repo inspection)
- Next.js App Router, TypeScript, React, Tailwind CSS.
- three, @react-three/fiber, optionally @react-three/drei only where beneficial.
- For custom distortion, a GLSL shader or custom material with GPU vertex displacement is preferred over large CPU vertex updates.
- Later: OpenAI API for streaming; PostgreSQL with Drizzle for persistent conversations, with anonymous sessions. Future app will have conversation history and chat persistence. Not milestone 1.
- Exact versions, runtime, hosting provider, authentication/session strategy and schema must be determined during their own milestones, not guessed now.
Milestone 1 experience
A single-page prototype with:
1. Small header with Lain 2.0 identity/status.
2. Compact 3D noise orb with subtle animated material/geometry.
3. Idle / Thinking / Talking controls for debugging, with visible state feedback.
4. Minimal chat message area and input as a visual placeholder only (no mocked promises of actual AI behavior).
5. Responsive mobile and desktop layout with good spacing and accessibility.
Later roadmap (do not pre-build)
1. Chat UX: message list, input and streaming UI.
2. Server-side OpenAI integration and real model lifecycle.
3. PostgreSQL + Drizzle, anonymous sessions, saved conversation history.
4. Bind AI streaming/responding to orb states, refine transitions and optional audio-related behavior if requested.
5. Mobile optimization, error states, accessibility, production-readiness, deployment.
Milestone 2 local preview
- The current chat shell uses reusable ChatWindow, ChatHeader, NewChat, ChatMessage and ChatInput components. Messages have stable UUIDs and explicit user/assistant roles, and exist only in React memory; refresh clears them.
- Replies are scripted and labeled as a local demo. Sending triggers Thinking for 900ms, then appends one complete assistant message with Talking for 1600ms, then restores Idle. There is no network request, model streaming, storage or backend.
- The same approved orb canvas remains mounted while its frame moves and shrinks near the header. Its renderer, geometry, animation helper and shaders are unchanged.
- Only the message log scrolls; it follows new messages when near the bottom and preserves the reader's position otherwise. Sending explicitly returns to the latest content. New Chat clears messages/draft and cancels pending work.
Explicit non-goals for now
- The separate developer portfolio redesign.
- The green theme from older prototypes.
- Giant orb visual or dominant full-screen 3D canvas.
- Separate constellation / particle alternatives. The reference's translucent wireframe Noise Orb is the current design.
- Backend integration, voice, authentication and database in the first milestone.
Open decisions
- Review the Milestone 2 layout and reversible local-demo timing (900ms Thinking / 1600ms Talking). Real request/streaming lifecycle remains a later milestone.
- Final UI layout after the first visual prototype is reviewed.
- Exact shader method/effect levels based on how the orb actually renders on target devices.
- Future chat model, deployment and persistence/session specifics.
