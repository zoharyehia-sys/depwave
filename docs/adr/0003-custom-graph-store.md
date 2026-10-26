# ADR 0003: Custom graph store over a graph library

- **Status:** Accepted
- **Date:** 2026-10-26

## Context
Incremental updates must remove all edges produced by one file in O(edges of that file), and impact traversal walks reverse edges over potentially millions of edges.

## Decision
A purpose-built `DependencyGraph` with interned integer ids, forward and reverse adjacency, per-file edge ownership, and an optional frozen CSR (typed-array) reverse index for traversal.
A graphology adapter is kept for export and visualization only.

## Consequences
- ✅ Ownership-based invalidation, zero-GC traversal, predictable memory.
- ⚠️ We own the algorithms (BFS, Tarjan SCC, topological sort). They're small and property-tested.
