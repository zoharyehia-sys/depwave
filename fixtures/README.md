# Fixtures

Small, realistic monorepos that act as the **spec** for depwave. Each fixture is:

```text
fixtures/<name>/
├── repo/                  # the monorepo snapshot (plain files, NOT installed, NOT a git repo)
└── expected-impact.json   # scenarios + golden expectations (schema: ../expected-impact.schema.json)
```

| Fixture | What it pins down |
|---|---|
| `pnpm-basic` | Cross-package propagation, barrel noise at file level, manifest changes as global triggers |
| `barrel-hell` | `export *`, named re-exports, barrel-of-barrels; comment-only changes |
| `ts-paths` | tsconfig `paths` aliases; file-vs-directory-index shadowing on add/delete (negative probes) |
| `cycles` | SCC detection; traversal termination inside a cycle |
| `dynamic-imports` | Template-literal globs, literal lazy imports, conservative widening for `import(expr)` |
| `pnpm-lockfile` | Lockfile diffs narrowed to the packages whose dependency closure changed; root, settings and hoisting fall back to everything |
| `instance-methods` | Methods called on interface-typed instances: a class must depend on all its members (regression found by self-hosting) |

## Rules for golden files

- `impactedTests` is the **exact** set: every test file not listed is asserted *not* impacted.
- `expected.file` is required. `expected.symbol` defaults to `file` and must be a subset of it.
- Lists are sorted; `modify.find` must occur exactly once in the file. `test/fixtures.test.ts` enforces all of this.
- Expectations assume the fixture's `policy` (all Phase 0 fixtures use `conservative`).
- Workspace packages must resolve **without** `node_modules`: depwave resolves them via the workspace manifest, so analysis works before `pnpm install`.

## How they're used

- `test/fixtures.test.ts` validates the goldens themselves.
- `test/golden.test.ts` copies `repo/` into a temp git repo, commits, applies each scenario as a second commit, runs the real
  pipeline, and asserts the exact `expected.file` test set. All scenarios pass. `expected.symbol` is checked from Phase 2.
