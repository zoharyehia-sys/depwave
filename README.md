# ripple

**AST-driven monorepo dependency & impact analyzer.** Given a git diff, ripple tells you which symbols, packages and tests are affected, and *why*.

> 🚧 **Status: Phase 0 (foundations).** Package skeletons, ports, layering rules and fixture goldens are in place. `ripple impact` exits with code 2 ("not implemented") until Phase 1.

- 📐 Design: [ARCHITECTURE.md](ARCHITECTURE.md)
- 🧾 Decisions: [docs/adr](docs/adr)
- 🧪 Spec-by-example: [fixtures](fixtures)

## Packages

| Package | Role |
|---|---|
| `@ripple/core` | Pure domain: model, **ports**, algorithms. No I/O, no npm deps. |
| `@ripple/parser` | Tree-sitter → `FileFacts` |
| `@ripple/resolver` | Module resolution with probe tracking |
| `@ripple/cache` | SQLite facts / resolution / snapshot cache |
| `@ripple/git` | `GitPort` over the git CLI |
| `@ripple/workspace` | Workspace discovery + source inventory |
| `@ripple/reporters` | text / json (+ markdown, sarif, mermaid later) |
| `@ripple/cli` | Clipanion commands + composition root |

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

Tests run against sources (Vitest aliases `@ripple/*` to `packages/*/src`), so no build is needed first.
