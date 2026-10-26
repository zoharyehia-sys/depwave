# ADR 0002: SQLite for the incremental cache

- **Status:** Accepted
- **Date:** 2026-10-26

## Context
The cache holds content-addressed facts, resolutions with probe sets, and per-commit graph snapshots. It must survive crashes and be shippable between CI jobs.

## Decision
A single SQLite file (`.ripple/cache.db`) via `better-sqlite3` in WAL mode. Keys use git blob OIDs where available, xxh3-128 otherwise.

## Consequences
- ✅ Transactional (no corrupt cache after a crash), one file for `actions/cache`, queryable for debugging, synchronous fast lookups.
- ⚠️ Single writer: parallel CI jobs open the cache read-only, and one job owns writes.

## Alternatives
JSON files (no atomicity, slow at scale), LMDB/RocksDB (heavier native deps, less inspectable), Redis (a server dependency for a CLI).
