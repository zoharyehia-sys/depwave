# ADR 0005: Own module resolver over a virtual file system, oxc-resolver as test oracle

- **Status:** Accepted
- **Date:** 2026-10-26

## Context
The resolver has two hard requirements beyond "resolve correctly":

1. **Complete probe lists**: every path checked, including missing ones, so the L2 cache can invalidate when, for example, `utils.ts` appears next to `utils/index.ts`.
2. **Revision-correct answers**: a diff's base commit must resolve against the files *at that commit*, which is generally not checked out.

oxc-resolver 11.x's JS API reads the real disk directly. It has no pluggable file system and doesn't report which paths it checked
(its result carries only `path`, `error`, `builtin`, `moduleType`, `packageJsonPath`). So it can satisfy neither requirement.

## Decision
- Implement resolution in TypeScript over a `VirtualFileSystem`: the tracked paths at a revision plus the preloaded contents
  of every `package.json` / `tsconfig*.json` / `jsconfig*.json`, built from git in one listing and one batched read.
  Every existence check goes through a `Lookup` that records it, so probe lists are complete and deterministic by construction.
  Cached lookups (nearest tsconfig/package.json) replay their probes.
- Semantics follow TypeScript's `bundler` mode, the most permissive: extensionless imports, `index` files,
  `.js` → `.ts` aliasing, tsconfig `paths`/`baseUrl`/`extends`/`customConditions`, and package `exports`/`imports`.
  Where the spec is strict, we're lenient (all matching conditions in priority order), because leniency only adds edges.
- Workspace packages resolve through their manifests, never `node_modules`. Missing build outputs map back to sources
  (tsconfig `outDir` → `rootDir`, else conventional `dist|build|out|lib|esm|cjs` → `src`).
- **oxc-resolver is a devDependency and a differential oracle**: every fixture is checked out, workspace packages are linked
  into `node_modules` the way pnpm would, and every import must resolve to the same file as oxc.

## Consequences
- ✅ Probe lists are provably complete: a property test adds every plausible unprobed file and asserts the answer never changes.
- ✅ Any commit resolves without a checkout; works before `pnpm install`.
- ⚠️ We own the algorithm. The oracle, the snippet corpus and the soundness property make divergence loud.
- ⚠️ Not modelled yet: tsconfig `include`/`files`/`references` scoping (the nearest tsconfig applies), `extends` from packages
  in node_modules, `moduleSuffixes`, `rootDirs`. Each is included in `configHash`, so changing it still invalidates the cache.
