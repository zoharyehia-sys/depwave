# depwave

**AST-driven monorepo dependency & impact analyzer.** Given a git diff, depwave tells you which symbols, packages and tests are affected, and *why*.

> 🚧 **Status: Phase 1 (file-level impact) works end to end.** `depwave impact` answers which test files a diff affects,
> verified on every fixture scenario and on this repo itself. Symbol-level precision, the persistent cache and `depwave why` come next.

## Usage

```bash
depwave impact --base origin/main
```

```bash
depwave impact --base main --head WORKTREE --format json
```

- `--base` is compared via its **merge base** with `--head`, so commits that landed on main after you branched don't count.
- `--head WORKTREE` includes uncommitted and untracked changes.
- `--cwd <dir>` analyzes another repository. Exit codes: `0` ok, `1` analysis failed (one-line message), `2` not implemented.

Paths that aren't part of the code under analysis (fixtures, examples, vendored copies) go in `depwave.config.json`:

```json
{ "ignore": ["fixtures/**"] }
```

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
