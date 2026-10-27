# depwave

**AST-driven monorepo dependency & impact analyzer.** Given a git diff, depwave tells you which symbols, packages and tests are affected, and *why*.

> 🚧 **Status: Phase 2 (symbol-level precision).** `depwave impact` follows changes symbol by symbol, binding imports
> through barrels to the defining symbol and ignoring comment/whitespace-only edits, with a persistent cache. Verified on
> every fixture scenario at both levels and on this repo itself. `depwave why` explains any selection.

## Usage

```bash
depwave impact --base origin/main
```

```bash
depwave impact --base main --head WORKTREE --format json
```

- `--base` is compared via its **merge base** with `--head`, so commits that landed on main after you branched don't count.
- `--head WORKTREE` includes uncommitted and untracked changes.
- `--granularity symbol` (default) follows individual functions, classes and variables; `--granularity file` is the
  coarser Phase 1 analysis. Symbol level never selects a test that file level wouldn't. See [ADR 0006](docs/adr/0006-symbol-level-model.md).
- `--cwd <dir>` analyzes another repository. `--no-cache` bypasses the cache.
- Exit codes: `0` ok, `1` analysis failed (one-line message on stderr), `2` not implemented.

## What selects which tests

Code changes follow the import graph (symbol by symbol). Changes no import can express follow these rules, all
conservative: when depwave can't see a dependency, it runs more tests, never fewer.

| Change | Selects |
|---|---|
| Lockfile, root `package.json`, workspace config, `depwave.config.json` | every test |
| CI definitions (`.github/workflows/`, `.gitlab-ci.yml`, …) and toolchain pins (`.nvmrc`, `.node-version`, `.tool-versions`, `.bun-version`, `.npmrc`) | every test: they change the environment tests run in |
| A `tsconfig*.json` / test-runner / Babel config | everything under its directory |
| A workspace package's `package.json` | that package and every package that depends on it |
| A file no code imports (JSON/text fixtures, templates, images) | the tests of its package: they may read it at runtime |
| `__snapshots__/x.test.ts.snap` | exactly `x.test.ts` |
| Docs and editor/lint config (`*.md`, LICENSE, `.vscode/`, …) outside test-data dirs | nothing |
| `import(expr)`, a test that spawns processes (`child_process`, `execa`, …), a file depwave can't parse | "may load anything in its package" |
| `import.meta.glob('./x/*.ts')`, `require.context(…)`, `` import(`./x/${n}.ts`) `` | every matching file |

## Explain a result: `depwave why`

```bash
depwave why packages/app/src/checkout.test.ts --base origin/main
```

```text
✔ packages/app/src/checkout.test.ts is impacted (symbol level, 909ad48fccd9...ad5322fd2231)

    packages/app/src/checkout.test.ts
      → runs its top-level code                  packages/app/src/checkout.test.ts
      → which calls renderCheckout               packages/app/src/checkout.ts:3
      → which calls PriceTag                     packages/ui/src/PriceTag.ts:3
      → which calls formatCurrency  ◀ changed    packages/utils/src/money.ts:1
```

- Shows the **shortest** chain from a change to the file, naming each relation (calls, uses, uses the type, re-exports, imports dynamically).
- A selection caused by a config change says so: `◀ selected because packages/utils/package.json changed`, never a made-up code path.
- Steps depwave can't prove statically (template globs, `import(expr)`) are marked `~`.
- Not impacted → says so; unknown path → exit code 1. Paths may be repo-relative or relative to where you are. `--format json` for tooling.

## GitHub Action: impact comment on every PR

```yaml
# .github/workflows/depwave.yml
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  impact:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # depwave needs the merge base
      - uses: zoharyehia-sys/depwave@main
        id: depwave
      # Optional: run only what changed.
      - run: npx vitest run ${{ steps.depwave.outputs.tests }}
        if: steps.depwave.outputs.run-all != 'true'
```

- Posts **one sticky comment** per PR (edited in place on every push): the headline (*"3 test files impacted of 41, 93% skipped"*),
  tests per package, global triggers, unresolved-import warnings, and `depwave why` paths for the top tests reached
  through other code.
- Also writes the report to the **job summary**, so fork PRs (read-only token) still show it. The comment is skipped with a warning.
- Inputs: `base` (default `origin/<PR base>`), `granularity`, `explain` (top N why-paths, default 3), `comment`, `github-token`.
- Outputs: `impacted-tests`, `total-tests`, `run-all`, `tests` (space-separated paths), `report` (JSON path).
- CLI equivalent: `depwave impact --base origin/main --format markdown --explain 3`.

## Shadow mode: prove it before you trust it

Running only the selected tests is a bet that depwave saw every dependency. Shadow mode checks that bet on real CI runs:
**keep running every test**, and let depwave check each failure against what it would have selected.

```bash
vitest run --reporter=default --reporter=json --outputFile.json=test-results.json
depwave shadow --base origin/main --results test-results.json
```

```text
depwave shadow 0123456789ab...HEAD: 1 failing test file NOT selected ✘
  a selective run would have run 4 of 29 test files (86% skipped)
  missed: test/action.test.ts
```

| Verdict | Meaning | Exit |
|---|---|---|
| `sound` | Every failing test was one depwave selected (or nothing failed) | 0 |
| `missed` | A failing test was **not** selected: a flaky test, or a dependency depwave can't see | **3** |
| `inconclusive` | Nothing missed, but some failures name no file (JUnit without paths) | 0 |

- Reads **Vitest/Jest JSON** (`--reporter=json`, `jest --json`) and **JUnit XML**; repeat `--results` for several runners.
  Relative paths are taken from the repo root (`--results-root` to change). The format is sniffed from the content.
- The output also tells you what a selective run would have saved, and which result files depwave doesn't see as
  tests (it can never select those).
- **GitHub Action:** pass `test-results: test-results.json` and run the action *after* your tests with
  `if: ${{ !cancelled() }}`. The verdict is appended to the PR comment, exposed as `shadow-verdict` / `shadow-missed`, and
  the job fails on a miss.
- This repo runs shadow mode on every CI build (`depwave-shadow.json` is uploaded as the track record). It has
  already paid off: its first run found that a test importing `post-comment.mjs` was linked to the `.d.mts` type stub
  next to it rather than to the code that runs. Now fixed: impact follows the runtime file.

**When to switch to selective runs:** after a few weeks of `sound` on your own repo. Keep a nightly full run anyway.

## Configuration: `depwave.config.json`

Optional, at the repository root. Read **from git at each analyzed revision**, like every other input, so the base and
head of a diff can each have their own config.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `ignore` | `string[]` (globs, repo-relative) | `[]` | Paths that aren't part of the code under analysis: fixtures, examples, vendored copies, generated code. Ignored paths define no packages, have no files in the graph, and never match dynamic-import globs. |

```json
{ "ignore": ["fixtures/**", "**/*.generated.ts"] }
```

- Unknown keys are ignored. A malformed file fails the run with `depwave: depwave.config.json: …`.
- Changing this file is a **global trigger**: every test is selected, since it changes what's analyzed.

## Cache

`depwave impact` keeps a cache in `.depwave/cache.db` at the repository root (SQLite, WAL mode). The directory contains a
`.gitignore` of `*`, so it never shows up in `git status` or in a `WORKTREE` analysis.

| Layer | Key | Holds |
|---|---|---|
| L1 facts | content hash + language + parser version | Parsed facts per file content: unchanged files are never re-parsed |
| L3 snapshots | commit SHA + analysis version | The whole graph of a commit: a warm merge base skips git listing, parsing and resolution |

Both keys are immutable inputs, so cached entries can't go stale; upgrading depwave changes the analysis version and
misses old entries. Uncommitted work (`WORKTREE`) is never snapshotted but still reuses L1 per file. On this repo a warm
run takes ~0.5 s vs ~1.1 s cold, and most of the warm time is Node startup.

The cache never changes an answer: if it fails (corrupt file, full disk, missing native binary), the run continues
uncached with a warning. Maintenance:

```bash
depwave cache stats
```

```bash
depwave cache clear
```

> **L2 (resolutions) is implemented but not used.** Resolution runs over an in-memory view of the revision at ~4 µs per
> import, which is faster than an SQLite hit (~6 µs). It's kept for a future disk-backed resolver. See ARCHITECTURE §4.1.

- 📐 Design: [ARCHITECTURE.md](ARCHITECTURE.md)
- 🧾 Decisions: [docs/adr](docs/adr)
- 🧪 Spec-by-example: [fixtures](fixtures)

## Packages

| Package | Role |
|---|---|
| `@depwave/core` | Pure domain: model, **ports**, algorithms. No I/O, no npm deps. |
| `@depwave/parser` | Tree-sitter → `FileFacts` |
| `@depwave/resolver` | Module resolution with probe tracking |
| `@depwave/cache` | SQLite facts / resolution / snapshot cache |
| `@depwave/git` | `GitPort` over the git CLI |
| `@depwave/workspace` | Workspace discovery + source inventory |
| `@depwave/reporters` | text / json (+ markdown, sarif, mermaid later) |
| `@depwave/cli` | Clipanion commands + composition root |

Layering is enforced by `dependency-cruiser`: **core → nothing**, **adapters → core only**, **cli → anything**.

## Develop

Requires Node ≥ 22 and pnpm 9 (`corepack enable` picks the pinned version).

```bash
pnpm install
```

```bash
pnpm check
```

`check` runs typecheck → dependency rules → tests → build. Individually: `pnpm typecheck`, `pnpm lint:deps`, `pnpm test`, `pnpm build`.

Tests run against sources (Vitest aliases `@depwave/*` to `packages/*/src`), so no build is needed first.
