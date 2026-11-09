# Lain 2.0 — Incremental Implementation Plan

This is an implementation guide, not a claim of completed work. Inspect repository code and adapt paths accordingly.

## Milestone 0 — Repository audit and foundations

- [ ] Inspect package manager, framework, package versions, App Router and current source tree.
- [ ] Inspect current scripts, assets, theme variables and existing agent instructions.
- [ ] Install only missing dependencies after verifying versions/compatibility.
- [ ] Establish theme tokens for plum, gold, amber and cream.
- [ ] Create a simple modular file structure; avoid unnecessary frameworks or abstractions.
- [ ] Run a baseline build/lint/typecheck and note any pre-existing issues.

**Done when:** The app runs locally, design tokens exist and baseline checks are documented.

## Milestone 1 — Compact procedural noise orb

- [ ] Create a client-only Three.js/R3F canvas loaded in a Next.js-compatible way, without SSR crashes.
- [ ] Render a noise-deformed, warm amber orb on transparent background; maintain apparent diameter 180–240px desktop, 120–160px mobile.
- [ ] Add restrained ambient movement and subtle pointer response.
- [ ] Model typed `idle | thinking | talking` states and smoothly interpolate deformation/energy uniforms.
- [ ] Idle: slow movement; Thinking: more frequent ripples; Talking: rhythmic controlled pulses.
- [ ] Provide test controls for state switching, labeled clearly as development/demo controls.
- [ ] Cap device pixel ratio, avoid unnecessary updates/allocations in frame loops and clean up resources.
- [ ] Honor `prefers-reduced-motion` and ensure an accessible fallback if WebGL is unsupported.

**Done when:** State changes are visually clear but calm, orb size is balanced in both viewports, no animation jumps, builds/checks pass.

## Milestone 2 — Minimalist conversation shell

- [ ] Design a quiet Lain header, welcome screen and chat area around the orb.
- [ ] Add an accessible chat-input component (visual UI only for now; label placeholder behavior honestly).
- [ ] Keep orb above welcome content; when messages appear, move/shrink orb to free reading space.
- [ ] Test narrow screens, keyboard access and soft keyboard avoidance.
- [ ] Keep debug controls removable or dev-only.

**Done when:** Desktop/mobile layouts look balanced and do not make the orb the dominant page element.

## Milestone 3 — Actual chat flow

- [ ] Implement messages, composer, loading/error states and streaming UI.
- [ ] Create a server-only OpenAI route/handler; never expose credentials to the client.
- [ ] Connect AI request lifecycle to typed states, including success, abort and error paths.
- [ ] Add appropriate basic request validation, rate/abuse protections and token/cost controls.

**Done when:** A real conversation streams visibly and the orb state follows the actual request lifecycle reliably.

## Milestone 4 — Persistence

- [ ] Choose PostgreSQL hosting and session design consciously.
- [ ] Add Drizzle schema/migrations for anonymous conversations/messages.
- [ ] Implement loading, saving, deletion, sessions and error recovery as needed.
- [ ] Reconcile persistence with streaming and retries.

**Done when:** Sessions persist and a returning anonymous visitor can resume their own conversation safely.

## Milestone 5 — Production polish

- [ ] Evaluate performance on mobile/desktop; ensure reduced-motion support and fallback rendering.
- [ ] Refine visual polish, accessibility, empty/error states and responsive behavior.
- [ ] Validate deployment environment, observability and server-only secrets.
- [ ] Prepare README and development/deployment instructions.

**Done when:** App passes available checks, works at target sizes and is ready for a user-approved deployment.

## Workflow / checkpoint after each milestone

1. Agent lists relevant files before changes.
2. Agent implements only agreed milestone scope.
3. Agent runs the available checks (record commands and outcomes).
4. User visually reviews the orb/layout; iterate before advancing.
5. Commit a stable checkpoint, without automatically pushing/deploying.

## Efficient Codex usage

- Use a cost-efficient model for ordinary component/style work; reserve stronger reasoning for GLSL math, rendering bugs or architecture decisions.
- Ask the agent to read `PROJECT_CONTEXT.md` once per new task and relevant source files rather than paste full chat transcripts.
- Keep requests focused: e.g. `Implement only Milestone 1 orb geometry + animation; no chat integration`.
