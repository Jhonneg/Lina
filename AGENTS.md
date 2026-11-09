<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

Lain 2.0 — Instructions for Coding Agents
Read these files in order before making changes:
1. PROJECT_CONTEXT.md — product intent, constraints, design decisions.
2. IMPLEMENTATION_PLAN.md — milestones, acceptance criteria and boundaries.
3. This file — rules for editing and reporting.
4. Repository-local instructions and source files relevant to the task.
Visual specifications:
- `docs/references/`
Working principles
- Inspect before changing: identify the actual framework version, package manager, routes, dependencies, existing conventions and scripts. Do not assume the repository is empty.
- Small tasks: implement one focused milestone or subtask per request. Prefer focused file reads over reloading the entire repository, especially to conserve Codex usage.
- No premature backend: milestone 1 is the UI and 3D orb only. Do not add OpenAI API, authentication, database, history or voice until instructed.
- Visual identity: minimalist, dark plum + muted gold + amber. Keep generous negative space; orb must be relatively small, not a giant hero illustration.
- Architecture: modular React/TypeScript code, reusable components, clear ownership of scene state. Prefer straightforward solutions over speculative abstractions or new dependencies.
- Animation: smooth frame-rate-independent transitions, subtle ambient movement, GPU-driven deformation when feasible, mobile-aware DPR and motion preferences. Avoid excessive bloom, flashing and unnecessary particle counts.
- Security: never put API credentials in client code; no secrets in git; server-only keys for future model access.
- Testing: run the repository's existing lint, typecheck/tests/build if available. If a check cannot run, explain why; never claim success without executing it.
- Git: preserve user changes, do not force-push or rewrite history. No deployment or destructive commands without explicit approval.
- Avoid scope creep: do not implement the alternate wireframe/particle/constellation prototypes unless the user asks. The noise orb is the v1 design.
Agent response format (brief)
For each task, report:
1. What you inspected and what assumptions were verified.
2. Files changed and what behavior they implement.
3. Checks executed and their actual outcome.
4. Known limitations and one recommended next task.
If a product decision is genuinely missing, make the smallest reversible assumption and record it in PROJECT_CONTEXT.md under Open decisions; don't stall on optional preferences.

## Execution Efficiency

Codex usage and execution time are important constraints.

- Work on one narrowly defined task at a time.
- Avoid unrelated refactoring or optional polish.
- Do not repeatedly inspect unchanged project files.
- Read only the context and source files relevant
  to the current task.
- Preserve existing working implementations.
- Run lint and typecheck once after changes.
- If validation fails, fix relevant errors and rerun
  only the affected check.
- Do not repeatedly attempt production builds when
  the known environment port-binding restriction
  remains unchanged.
- Perform one focused browser verification when
  visual changes require it.
- Avoid repeated screenshot comparisons unless
  specifically requested.
- Report unfinished work rather than expanding scope.
- Stop after satisfying the task's acceptance criteria.
