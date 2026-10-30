# Contributing

## Setup

Requires Node.js 22 or later and git. pnpm 9 comes through Corepack, pinned by `packageManager` in `package.json`.

```bash
corepack enable
pnpm install
pnpm check
```

`pnpm check` runs the typecheck, the dependency layering rules, the tests and the build, the same as CI. They also run
separately: `pnpm typecheck`, `pnpm lint:deps`, `pnpm test` and `pnpm build`. Tests run against the sources (Vitest
aliases `@depwave/*` to `packages/*/src`), so no build is needed first. The CLI itself runs from the build:
`node packages/cli/dist/bin.js`.

CI runs on Ubuntu, Windows and macOS, and on a checkout path with spaces and Hebrew characters: path handling bugs hide
there.

## The npm package

`packages/cli` is the published `depwave` package; the other packages are private. Packing it runs
[`bundle.mjs`](packages/cli/bundle.mjs), which puts them in one file along with every dependency except `better-sqlite3`
and `web-tree-sitter`. `pnpm build && pnpm smoke:pack` packs it, installs the tarball into a clean project and runs it,
the same as CI on every OS. The version in `packages/cli/package.json` is what `--version` prints, and it's part of the
cache key.

The two Tree-sitter grammars are vendored in [`packages/parser/grammars`](packages/parser/grammars).

## Layout

| Package | Role |
|---|---|
| `@depwave/core` | Domain model, ports and algorithms: graph, diff analysis, impact walk, test selection. No I/O |
| `@depwave/parser` | Tree-sitter extraction of imports, exports, symbols and references |
| `@depwave/resolver` | Module resolution over a git revision |
| `@depwave/workspace` | Workspace discovery, source inventory, lockfile analysis |
| `@depwave/git` | Git access through the `git` CLI |
| `@depwave/cache` | The SQLite cache |
| `@depwave/reporters` | Text, JSON and Markdown reports |
| `depwave` (`packages/cli`) | Commands, and the composition root. The one published package |

`dependency-cruiser` enforces the layering: `core` imports nothing, adapters import only `core`, and `cli` may import
anything. [ARCHITECTURE.md](ARCHITECTURE.md) has the design, and [docs/adr](docs/adr) the decisions behind it.

Other folders:
- [`fixtures/`](fixtures/README.md): example monorepos with scripted changes and expected impact at both granularities.
  They are the spec: a behavior change starts with a fixture scenario.
- [`scripts/`](scripts): the [benchmark](docs/benchmarks.md) and the demo repository behind the README.
- `action.yml` and [`action/`](action): the GitHub Action.

## Changes to selection rules

depwave's value is in selecting the right tests, not fewer of them
([ADR 0004](docs/adr/0004-soundness-over-precision.md)). A change that can make a selection smaller needs:

- a fixture scenario or test that shows the narrower selection is still correct;
- a test that fails when the new rule is disabled or weakened (mutation-check it: break the rule, watch a test fail);
- for lockfile or trigger rules, a replay on real repositories with `scripts/bench/lockfile-replay.mjs`.

## Reporting a missed test

The most useful report contains the `depwave why <test>` output for the missed test, the shadow-mode verdict that
exposed it, and the import or runtime mechanism depwave didn't see.
