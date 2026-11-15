# Dependency security review — Milestone 6A

Reviewed 15 November 2026 using the installed npm dependency tree, registry package
manifests, `npm audit --json`, `npm audit --omit=dev --json`, and the upstream
advisories linked below. This is a reachability assessment of these two known
advisories, not a general production security approval.

## Outcome

No compatible advisory fix is currently published within the affected parents'
declared ranges. Dependencies and lockfile are deliberately unchanged by this
review. No forced audit fix, framework upgrade, prerelease, downgrade or override
was applied. An unrelated patch update would leave both advisories unresolved.
The previous legacy-voice cleanup and all existing working-tree changes remain.

| Audit scope | Before | After | Severity |
| --- | ---: | ---: | --- |
| All dependencies | 11 | 11 | Moderate only; zero high/critical |
| Production (`--omit=dev`) | 0 | 0 | No reported advisories |

Eleven findings represent two underlying advisories plus their affected parent
packages, not eleven distinct exploits. Both chains originate in development
packages. A full install may still put them on a production machine; the clean
production-only audit does not prove they are absent from such an image.

## minimatch: seven affected package names

Chain: `eslint-config-next@16.4.5` → `typescript-eslint@8.72.1` → parser/utils/
type-utils/eslint-plugin → `@typescript-eslint/typescript-estree@8.72.1` →
`minimatch@10.2.6`.

[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)
affects minimatch >=7 and <11.0.1. Malicious patterns can amplify CPU/memory work
when `optimizationLevel >= 2`. The inspected ESTree call in
`dist/useProgramFromProjectService.js` uses `minimatch(filePath, pattern,
{ dot: true })` for `allowDefaultProject`. It does not enable optimization level
2; minimatch defaults to 1. Our ESLint configuration does not enable
`projectService`/`allowDefaultProject` or accept patterns from chat requests.
No production application imports of this tooling were found. The vulnerable
feature is therefore not exercised by the inspected configuration/call site;
this is an inference from source inspection, not a guarantee for future configs.

The latest stable ESTree release checked, 8.72.2, still requires
`minimatch: ^10.2.2`; the latest 10.x is 10.2.6. The fixed 11.0.1 is outside this
range. `eslint-config-next` allows TypeScript ESLint updates, but there is no
published compatible parent release adopting that fixed major. npm's
`fixAvailable: true` and dry-run proposal to patch TypeScript ESLint to 8.72.2 do
not establish remediation: its published manifest still admits only vulnerable
minimatch 10.x. Do not force a major transitive replacement to silence the audit.

Mitigation: keep lint patterns/configuration trusted, avoid enabling minimatch's
level-2 optimization on untrusted patterns, and isolate CI jobs handling untrusted
changes with resource limits and without secrets. Recheck the parent's releases
for upstream support of patched minimatch; then update that chain and validate.

## esbuild: four affected package names

Chain: `drizzle-kit@0.31.11` → `@esbuild-kit/esm-loader@2.6.5` →
`@esbuild-kit/core-utils@3.3.2` → `esbuild@0.18.20`.

[GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)
affects esbuild <=0.24.2; fixed in 0.25.0. Its development HTTP server permits
cross-origin reads, including requests from a malicious website to a developer's
loopback server. Binding that vulnerable server only to localhost is insufficient.
The vulnerable behavior requires esbuild's serve API; using its transforms alone
does not expose that server.

The inspected core-utils exports use `transform`/`transformSync`, not `serve`.
Current Drizzle Kit's config registration uses its bundled tsx implementation.
Project scripts run Next.js for development and Drizzle CLI for generation and
migration; no esbuild serve API calls or production imports of this tooling were
found. This advisory's HTTP-server feature is not exercised by those inspected
paths. This does not assess every Drizzle command or all future uses of esbuild.

Drizzle Kit 0.31.11 remains the latest stable version checked and still declares
the deprecated esm-loader. Its latest 2.6.5 depends on core-utils, whose latest
3.3.2 pins esbuild `~0.18.20`. Drizzle's separate esbuild 0.25.12 and tsx's esbuild
0.28.2 are already outside this advisory, but cannot replace that nested version
under its declared range. npm suggests Drizzle Kit 0.18.1 as a forced downgrade;
that is incompatible with this project's current toolchain and is not a safe fix.
The loader's migration to tsx is an upstream dependency cleanup, not a verified
local drop-in override.

Mitigation: do not start the vulnerable esbuild serve API; keep database tooling
private and run only needed generation/migration commands. Build with dev tools in
a trusted build stage and exclude dev dependencies from the runtime artifact where
supported by the deployment workflow. Recheck Drizzle's stable releases for removal
or replacement of the obsolete loader. Do not expose development/admin servers.

## Validation and boundaries

Only this review document and the README pointer are new changes for 6A. No
application behavior, voice settings, shaders, UI, schema, deployment restrictions
or package versions were changed. Validation results are recorded below. No
billable requests, live database operations or production builds are required.

- `npm run lint`: passed once.
- `npm run typecheck`: passed once.
- `npm test`: 100 server/chat tests and 7 rendering tests passed once.
- `npm run test:cloud-voice`: 39 focused mock tests passed once.
- Final full audit: 11 moderate, zero high/critical (exit 1, findings remain).
- Final production-only audit: zero findings (exit 0).
- No billable requests or development-database mutations were performed.

Recommended next task: recheck for stable upstream releases adopting minimatch
11.0.1+ and removing the deprecated Drizzle loader before any public deployment.
Do not treat these exposure assessments or an audit count as deployment approval.
