# Lockfile changes

Dependency updates from Renovate or Dependabot usually touch only a lockfile and a manifest. Instead of treating that
as "run everything", depwave diffs the lockfile and selects the workspace packages whose **resolved dependency tree**
changed, even when the change is deep in the tree (`debug` moving to a new `ms` selects whoever uses `debug`). It then
adds the packages that depend on them. The design and its soundness argument are in
[ADR 0004](adr/0004-soundness-over-precision.md#lockfile-narrowing-added-2026-10-28).

## Supported formats

| | pnpm | npm | Yarn Berry |
|---|---|---|---|
| Files | `pnpm-lock.yaml` | `package-lock.json`, `npm-shrinkwrap.json` | `yarn.lock` |
| Formats | Lockfile v6 and v9, including pnpm 11+ multi-document lockfiles | `lockfileVersion` 2 and 3 | Yarn 2+ lockfiles (with `__metadata`) |
| How dependencies resolve | pnpm's resolved graph, per importer | Node-style lookup through nested `node_modules` | Descriptor to resolution |
| Layout | Isolated | Hoisted | Plug'n'Play, or hoisted with `nodeLinker: node-modules` or `pnpMode: loose` |

Yarn classic (v1), Bun (`bun.lock`, `bun.lockb`), npm `lockfileVersion` 1, and pnpm lockfiles without `importers` are
not analyzed: a change to one selects every test.

## How a change is narrowed

All three formats are read into one model: importers (the root and each workspace package), resolved package
entries, and the dependencies between them.

1. Every package entry that differs between the two revisions is a change. Any field counts, so a change to the
   integrity hash alone still counts.
2. A workspace package is affected when its own entry changed, or when it can reach a changed entry at head.
3. Its tests are selected, plus the tests of every package that depends on it.

Lockfiles count only at the repository root or at a package root. Elsewhere (in a fixture, say) they are treated as
data files.

Real output for an `effect` upgrade in tRPC, commit `dce10f3`. It selected 79 of 207 test files:

```console
$ depwave impact --base dce10f3~1 --head dce10f3
depwave impact 50543c8d417a...dce10f33777d (symbol level)
  changed files:  3
  impacted nodes: 573
  impacted tests: 79
  trigger:        packages/tests/package.json (package-manifest)
  trigger:        pnpm-lock.yaml (lockfile, 2 packages: effect 3.21.0 → 3.22.2)
  trigger:        www/package.json (package-manifest)
  ⚠ unresolved imports: 1 (see --format json)
```

## Hoisted layouts

npm, and Yarn with `nodeLinker: node-modules` or `pnpMode: loose`, put dependencies in the root `node_modules`. There,
code can import a package its manifest never declared, and it works. So depwave records each file's third-party
imports, and also selects packages whose code imports a changed package, or a package that depends on one.

pnpm's isolated layout and Yarn Plug'n'Play reject undeclared imports, so declared dependencies are enough there.

## When every test is selected

depwave selects every test, and names the reason, when a lockfile change isn't confined to packages:

- The root importer's dependencies changed. The root `node_modules` is on every package's lookup path.
- A changed package matches `*eslint*` or `*prettier*` (pnpm's default public-hoist patterns), or a
  `public-hoist-pattern` you configured. Tools like these load plugins by name from the root.
- Everything is hoisted: pnpm's `shamefully-hoist=true` or `node-linker=hoisted`.
- The package manager changed (the env document of pnpm 11+ lockfiles), or a global section changed: pnpm `settings`,
  `overrides` and `patchedDependencies`, npm's top-level fields, or Yarn's `__metadata`.
- The lockfile's format version changed, or the lockfile was added, deleted or can't be parsed.
- The format isn't analyzed (see above).

How often each of these fired on real repositories is in the [benchmark report](benchmarks.md).
