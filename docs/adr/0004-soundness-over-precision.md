# ADR 0004: Soundness over precision

- **Status:** Accepted
- **Date:** 2026-10-26

## Context
A test-selection tool that misses a failing test destroys trust instantly. One that selects a few extra tests just costs CI minutes.

## Decision
When analysis is uncertain, widen the impact set:
- Fully dynamic imports (`import(expr)`) create a wildcard dependency on the importer's package.
- Namespace and CommonJS imports depend on every export of the target.
- Lockfile, tsconfig and package manifest changes are global triggers.
- Precision features (symbol-level, barrel resolution) may only *remove* tests that are provably unaffected.
  Invariant: symbol-level impact ⊆ file-level impact.

## Consequences
- ✅ Enforced selection can be trusted, backed by shadow-mode recall metrics in CI.
- ⚠️ Codebases with heavy runtime magic see less reduction until plugins teach depwave their conventions.
