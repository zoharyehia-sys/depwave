# depwave

**AST-driven monorepo dependency & impact analyzer.** Given a git diff, depwave tells you which symbols, packages and tests are affected, and *why*.

> 🚧 **Status: Phase 0 (foundations).** Package skeletons, ports, layering rules and fixture goldens are in place. `depwave impact` exits with code 2 ("not implemented") until Phase 1.

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
