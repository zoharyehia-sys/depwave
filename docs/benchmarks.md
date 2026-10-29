# Benchmark: lockfile changes on real repositories

How much of the test suite depwave skips for dependency updates, measured by replaying every lockfile commit in four
open-source monorepos.

## Summary

| Repository | Lockfile | Commits replayed | Narrowed | Test-file runs (baseline) | Selected | Skipped |
|---|---|---|---|---|---|---|
| [tRPC](https://github.com/trpc/trpc) | pnpm | 9 | 7 | 1,871 | 717 | **1,154 (62%)** |
| [Vite](https://github.com/vitejs/vite) | pnpm | 11 | 4 | 4,573 | 3,122 | **1,451 (32%)** |
| [Jest](https://github.com/jestjs/jest) | Yarn Berry, hoisted | 24 | 5 | 29,384 | 26,445 | **2,939 (10%)** |
| [Playwright](https://github.com/microsoft/playwright) | npm | 7 | 0 | 4,103 | 4,103 | 0 (0%) |

"Narrowed" counts the commits that didn't select every test.

## Method

- **Commits.** Every commit in the window below that changed the root lockfile, compared with its first parent:
  `depwave impact --base <sha>~1 --head <sha> --format json`. A commit whose parent falls outside the shallow clone
  can't be compared and is left out (one per repository).
- **Baseline.** Running every test file at that commit: `plan.totalTests`, the number of files depwave classifies as
  tests (`*.test.*` / `*.spec.*` with a JS or TS extension, or a JS or TS file under `__tests__/`).
- **Selected.** The test files depwave selected, or every test file when a global trigger fired (`plan.runAll`).
- **Skipped.** Baseline minus selected, summed over the commits. The percentage is of the summed baseline.
- **Granularity:** symbol, the default.

| Repository | Pinned commit | Window | Lockfile |
|---|---|---|---|
| tRPC | [`e237729`](https://github.com/trpc/trpc/commit/e237729d3ca2f4bb34e6084424e62d12f70380d3) (2026-10-27) | Last 60 commits | `pnpm-lock.yaml` |
| Vite | [`cce559a`](https://github.com/vitejs/vite/commit/cce559ab158cc6b177d0911a0bea73436b48faff) (2026-10-27) | Last 60 commits | `pnpm-lock.yaml` |
| Jest | [`61050e9`](https://github.com/jestjs/jest/commit/61050e9323e742539dc2360236671110e37329e6) (2026-10-02) | Last 120 commits | `yarn.lock` |
| Playwright | [`1b9b602`](https://github.com/microsoft/playwright/commit/1b9b602724484df3ebc41aba77824fdfaba861f6) (2026-10-28) | Last 120 commits | `package-lock.json` |

**Environment.** depwave as of [#13](https://github.com/zoharyehia-sys/depwave/pull/13) (module-evaluation fix), Node.js 22.14, git
for Windows, Windows 11, re-measured on 2026-10-29 from cold caches. Selection doesn't depend on the machine; run times weren't measured.

## Reproduce

```bash
pnpm install && pnpm build
node scripts/bench/readme-benchmark.mjs              # all four, into <tmp>/depwave-bench
node scripts/bench/lockfile-replay.mjs <repo> <lockfile>   # any repository you have cloned
```

[`readme-benchmark.mjs`](../scripts/bench/readme-benchmark.mjs) fetches each repository at its pinned commit as a
shallow clone without checking it out (depwave reads git objects only, and some of these repositories have
paths too long to check out on Windows). It then runs [`lockfile-replay.mjs`](../scripts/bench/lockfile-replay.mjs)
on each one and prints the summary table. It needs network access and took 4 minutes on the machine above.

## What this does and doesn't show

- **Lockfile commits only.** Most changes are code changes, which this doesn't measure. Dependency updates are where
  depwave used to select everything, so they are where narrowing matters most.
- **Test files, not CI time.** Skipping 62% of test files doesn't save 62% of CI minutes. Tests differ in how long
  they take, and checkout, install, build and runner startup cost the same either way.
- **Selection size, not correctness.** No test suite ran. Whether the skipped tests would have passed rests on the
  [selection rules](lockfiles.md) and on [shadow mode](../README.md#shadow-mode) in your own CI.
- **A small sample.** 51 commits from four repositories. Another repository's numbers depend mostly on its layout:
  where tooling lives, how much is hoisted, and how often the root manifest changes.

## Every commit

✔ narrowed · ■ every test selected. The reason is depwave's own explanation, shortened.

### tRPC

| Commit | Selected | Lockfile change, or why everything ran |
|---|---|---|
| `a6e0813` devalue v6 | ■ 211 / 211 | `pnpm-workspace.yaml` changed in the same commit |
| `22fbe2b` docs: tweet embeds | ✔ 0 / 211 | 3 packages removed, reaching only the docs site (`www`), which has no tests |
| `f15d2a1` switch to lerna-lite | ■ 207 / 207 | The lockfile's `patchedDependencies` changed |
| `fbf34a5` babel monorepo v8 | ✔ 0 / 207 | 86 Babel packages added, reaching only `www` |
| `7095886` jscodeshift 17.4 | ✔ 8 / 207 | Babel helpers removed |
| `dce10f3` effect 3.22.2 | ✔ 79 / 207 | `effect` 3.21.0 → 3.22.2 |
| `50543c8` @clack/prompts 1.x | ✔ 8 / 207 | `@clack/core`, `@clack/prompts` and 3 more |
| `8c85229` @oxc-project/runtime | ✔ 204 / 207 | `@oxc-project/runtime` 0.123.0 → 0.152.0 |
| `cd1f4d2` docusaurus-plugin-typedoc | ✔ 0 / 207 | 2 packages, reaching only `www` |

### Vite

| Commit | Selected | Lockfile change, or why everything ran |
|---|---|---|
| `46b91c5` non-major dependencies | ■ 418 / 418 | pnpm itself changed (12.14.0 → 12.15.0) |
| `ac9a56d` tsdown 0.23.2 | ✔ 14 / 418 | `tsdown` and `rolldown-plugin-dts` |
| `ac67ede` dynamic-import cases | ✔ 2 / 418 | Playground packages added |
| `67c965b` @rollup/plugin-alias 6.0.1 | ■ 418 / 418 | `pnpm-workspace.yaml` changed in the same commit |
| `96d1578` @node-rs/bcrypt v2 | ✔ 2 / 415 | `@node-rs/bcrypt` and 13 platform packages |
| `a711f1c` ssr: external require | ✔ 197 / 415 | 35 rolldown and oxc packages removed |
| `a63eb87` rolldown-related | ■ 415 / 415 | Root dependencies changed |
| `77d8373` non-major dependencies | ■ 414 / 414 | pnpm itself changed (12.11.2 → 12.14.0) |
| `c2e0418` rolldown-related | ■ 414 / 414 | Root dependencies changed |
| `928e721` TypeScript v7 | ■ 414 / 414 | The lockfile's `overrides` changed |
| `5b73935` migrate to Oxlint | ■ 414 / 414 | `@e18e/eslint-plugin` is hoisted (`*eslint*`) |

### Jest

| Commit | Selected | Lockfile change, or why everything ran |
|---|---|---|
| `61050e9` eslint-plugin-jsdoc | ■ 1,363 / 1,363 | Hoisted `*eslint*` package |
| `f2e2aa2` lock file maintenance | ■ 1,363 / 1,363 | Hoisted `*eslint*` package |
| `4685157` update ts-eslint | ■ 1,363 / 1,363 | Hoisted `*eslint*` package |
| `74bd550` jest-each fix | ✔ 873 / 1,359 | Resolution metadata only |
| `3aa9b8b` CoverageReporter test | ■ 1,355 / 1,355 | Root dependencies changed (`mock-fs` removed) |
| `0683cdd` glob v13 | ■ 1,346 / 1,346 | Root importer changed (resolution metadata) |
| `e95d9db` lock file maintenance | ■ 1,346 / 1,346 | Hoisted `*eslint*` package |
| `071ea1a` lock file maintenance | ■ 1,193 / 1,193 | Hoisted `*eslint*` package |
| `1c21e32` TypeScript compatibility job | ■ 1,188 / 1,188 | Root dependencies changed |
| `30b0642` nanoid 3.3.18 | ✔ 0 / 1,182 | `nanoid`, reaching only `jest-website`, which has no tests |
| `d067e24` pretty-format fix | ✔ 1,156 / 1,182 | Resolution metadata only |
| `b614603` @jest/source-map | ■ 1,181 / 1,181 | The root `package.json` changed in the same commit |
| `cceb1e6` eslint-plugin-jsdoc | ■ 1,176 / 1,176 | Hoisted `*eslint*` package |
| `cfc27d4` react-native example | ■ 1,175 / 1,175 | The root `package.json` changed in the same commit |
| `8e6d128` istanbul dependencies | ✔ 1,088 / 1,175 | `babel-plugin-istanbul`, `test-exclude` |
| `491c9d5` lock file maintenance | ■ 1,171 / 1,171 | Root dependencies changed |
| `f6dee87` haste-map watcher | ■ 1,160 / 1,160 | Root dependencies changed |
| `be2d67d` lock file maintenance | ■ 1,158 / 1,158 | Hoisted `*eslint*` package |
| `f81708e` Babel RC releases | ■ 1,158 / 1,158 | Root dependencies changed |
| `01e18c6` more deps | ■ 1,158 / 1,158 | Hoisted `*eslint*` package |
| `5ed1875` tstyche | ■ 1,158 / 1,158 | Root dependencies changed |
| `f49721c` a couple of deps | ■ 1,158 / 1,158 | Root dependencies changed |
| `12c85fb` eslint-plugin-jsdoc | ■ 1,158 / 1,158 | Hoisted `*eslint*` package |
| `f63ceff` graphql v17 | ✔ 0 / 1,158 | `graphql`, reaching only `jest-website` |

### Playwright

| Commit | Selected | Lockfile change, or why everything ran |
|---|---|---|
| `e478109` undici | ■ 586 / 586 | Root dependencies changed |
| `5cabe8e` electron 42.11.16 | ■ 586 / 586 | Root dependencies changed |
| `0a626ef` fast-uri 3.1.9 | ■ 586 / 586 | Root dependencies changed |
| `7d001dc` @modelcontextprotocol/sdk | ■ 586 / 586 | Root dependencies changed |
| `15cdc4e` electron 42.11.3 | ■ 586 / 586 | Root dependencies changed |
| `b4891f1` vite 8.1.6 | ■ 586 / 586 | Root dependencies changed |
| `343d8e7` test runner cleanup | ■ 587 / 587 | Root importer changed (resolution metadata) |

Playwright keeps its development tooling in the root `package.json`, and npm hoists everything, so every one of these
updates reaches the root importer, which every package can load from.
