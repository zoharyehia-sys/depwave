# ADR 0004: Soundness over precision

- **Status:** Accepted
- **Date:** 2026-10-26

## Context
A test-selection tool that misses a failing test destroys trust instantly. One that selects a few extra tests just costs CI minutes.

## Decision
When analysis is uncertain, widen the impact set:
- Fully dynamic imports (`import(expr)`) create a wildcard dependency on the importer's package.
- Namespace and CommonJS imports depend on every export of the target.
- Lockfile, tsconfig and package manifest changes are global triggers (lockfiles are narrowed since 2026-10-28, below).
- Precision features (symbol-level, barrel resolution) may only *remove* tests that are provably unaffected.
  Invariant: symbol-level impact ⊆ file-level impact.

### Runtime dependencies (added 2026-10-27, after running depwave on tRPC and Vite)
Real repositories showed tests whose dependencies no import expresses, so these are now selected conservatively:
- **CI and toolchain changes** (a Bun version bump in a workflow selected 0 tests in tRPC) → every test.
- **Tests that spawn processes** (Vite's `create-vite` CLI test runs the package as a process) → depend on every file of their package.
- **Files no code imports** (templates, JSON fixtures) → the tests of their package. Snapshots → exactly their test.
  Since 2026-10-28 also every test importing one of the package's test helpers (non-test code in test directories):
  depwave's own parser and resolver tests load the root's fixtures through `test/support/fixtures.ts` and were missed.
- **Files whose extraction crashes** → may depend on anything in their package, instead of failing the whole run.

### Lockfile narrowing (added 2026-10-28)
Running every test on every dependency bump was the largest precision loss left. `pnpm-lock.yaml` records each workspace
importer's resolved dependency graph, so a change can be pinned to the importers that reach a changed entry, which is
exact for packages installed in isolation. Precision may only remove provably unaffected tests, so everything that breaks
that isolation selects every test: the root importer (its `node_modules` is on every package's lookup path), public or
full hoisting, the package manager itself (the env document), lockfile settings/overrides/patches, and any lockfile
depwave can't parse. npm, yarn and bun lockfiles still select everything.

## Consequences
- ✅ Enforced selection can be trusted, backed by shadow-mode recall metrics in CI.
- ⚠️ Codebases with heavy runtime magic see less reduction until plugins teach depwave their conventions.
