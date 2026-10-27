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
