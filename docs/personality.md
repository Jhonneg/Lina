# Lain personality

The canonical approved **LAIN — The Digital Consciousness, version 1.0** lives in
`src/server/ai/personality.ts`. This server-only module exports the version and
the supplied instructions. Edit that module for an explicitly approved revision;
do not maintain duplicate prompt text elsewhere.

Both OpenAI Responses API paths in `openai-adapter.ts` use those instructions in
the top-level `instructions` field, separately from the user/assistant `input`.
The adapter reapplies them on every request. Client payloads cannot select or
replace them: existing validation rejects additional fields and privileged roles.
This isolates the instruction field; it does not guarantee immunity to all
natural-language prompt injection.

The prompt is not appended to conversation messages or saved in the database.
Session ownership, context bounds, idempotency, cancellation and API contracts
are unchanged. Development mocks keep their deterministic response and timing.

`npm test` includes fake-transport tests for both provider paths, override
rejection, the persistence boundary, and mocks; no OpenAI API calls are needed.
