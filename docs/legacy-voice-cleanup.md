# Legacy voice cleanup — Milestone 5F.5

Removed the direct dependency `kokoro-js@1.2.1` and 65 exclusively associated
transitive package entries (66 total), including Transformers.js, Hugging Face
Jinja, ONNX Runtime node/web/common, phonemizer, and the older nested Sharp/native
image libraries. The current Sharp dependency required by Next.js remains.
`npm uninstall` was run offline with lifecycle scripts disabled; retained package
versions were unchanged. No audit fixes or automatic major upgrades were applied.

Removed the inference provider, synthesis worker, benchmark worker, download
factory/types and encoded-audio engine, obsolete chat controller and local preview
routes/components. Retained shared Refined DSP, PCM players, audio analysis,
Markdown segmentation, numeric diagnostics, cloud design lab and approved preset.
The voice controls' view type now lives in `voice-types.ts` with no local-engine
import or download-consent field. Shared DSP/conversion tests were preserved;
neural-only fixtures were removed. No browser cache or external benchmark artifact
was deleted; historical reference HTML and benchmark JSON remain intentionally.

## npm audit comparison

Registry audit metadata was fetched before and after removal, 15 November 2026.
Counts represent affected packages, including transitive/meta-vulnerabilities,
not distinct advisories. `npm audit` returns exit code 1 while findings remain.

| Audit | High | Moderate | Total | Dependency entries |
| --- | ---: | ---: | ---: | ---: |
| Before | 3 | 11 | 14 | 761 |
| After | 0 | 11 | 11 | 695 |

The three high findings disappeared with Kokoro, Transformers and their nested
Sharp dependency. Eleven moderate findings remain in development tooling:

- `esbuild` through `@esbuild-kit/core-utils`, `@esbuild-kit/esm-loader` and
  `drizzle-kit`: [development-server origin exposure](https://github.com/advisories/GHSA-67mh-4wv8-2f99).
- `minimatch` through `@typescript-eslint/typescript-estree`, parser, utils,
  type-utils, eslint-plugin and `typescript-eslint`:
  [glob amplification denial of service](https://github.com/advisories/GHSA-g3hv-75wg-m249).

These are two advisory chains covering eleven reported package names. Address
compatible tooling updates in a separate reviewed task; this cleanup does not
apply npm's suggested major/downgrade changes to Drizzle Kit or unrelated updates.
The existing production voice restriction, persistent usage controls and database
schema were preserved. No billable requests are needed for cleanup validation.

## Validation results

- Lint and TypeScript checks passed.
- Regression suite: 100 server/chat and 7 rendering tests passed.
- Focused cloud voice: 39 tests passed.
- Shared reference DSP: 2 tests; audio analysis: 5 tests; usage policy: 4 tests passed.
- Source/import searches and lockfile inspection found no live local-inference
  imports, workers or model dependencies. Historical reference HTML/benchmarks
  intentionally retain their original terminology.
- Approved preset SHA-256 was unchanged. Retained dependency versions were unchanged.
- No billable calls, database mutations, browser cache deletions or builds were run.
