# ADR 0006: Symbol-level impact model

- **Status:** Accepted
- **Date:** 2026-10-27

## Context
File-level impact over-selects at barrels: changing `Button` impacts every importer of `ui/index.ts`. Phase 2 makes impact
symbol-precise without giving up soundness (ADR 0004).

## Decision
### Nodes
A file plays two roles, so it gets two nodes:

| Node | Meaning |
|---|---|
| `sym:F#S` | one symbol (function, class, method, variable, type, …) |
| `sym:F#<module>` | F's top-level code: imports, side effects, export clauses |
| `file:F` | "any part of F": the target of dependencies that can't name a symbol |

### Edges (dependent → dependency)
- `file:F ─PART_OF→ sym:F#X`: "any part of F" changes when a part does.
- `sym:F#X ─IN_MODULE→ sym:F#<module>`: every symbol depends on its file's top-level code.
- `sym:F#Class ─PART_OF→ sym:F#Class.method`: **a class depends on all its members.** Method calls usually go through
  instances (often typed as interfaces), which syntax alone can't bind. Found by running depwave on itself: without this
  edge, a change to `GitError` missed `cli.test.ts` (fixture `instance-methods` pins it).
- `sym ─CALLS/REFERENCES→ sym`: references bound through imports, and through any chain of `export *` /
  `export { x } from` barrels, to the **defining** symbol (`ReExportResolver`, following ES-module rules: explicit beats
  `export *`, `export *` skips `default`, cycles terminate).
- `sym ─REFERENCES→ file`: a binding that can't be resolved to a symbol (namespace used as a value, CommonJS, assets).
- `sym|<module> ─IMPORTS/DYNAMIC_IMPORT→ file`: side-effect imports, bare `require()`, and `import()`, attributed to the
  enclosing symbol.
- `file ─RE_EXPORTS→ file`: kept, so whole-module users of a barrel still see changes behind it.
- **Module evaluation** (added 2026-10-29, from an external review): loading a module runs its top-level code whether or
  not any binding is used, so
  - `sym|<module> ─IMPORTS→ sym:T#<module>` for every value import (named or default, used or not) and every
    re-export: loading the importer loads T, and a barrel's importers load every module behind it;
  - `sym:F#<module> ─PART_OF→ sym:F#X` when X's initializer runs code on load (`const h = register()`; the parser
    flags it as `effectful`).

  Before this, `import { helper } from './setup'` with `helper` unused created no edge at all, so a change to
  `setup.ts`'s top-level code (`registerGlobalHandler()`) missed the importer; so did an effectful initializer, and
  any side effect in a module behind a barrel. Type-only imports are erased at runtime and get no evaluation edge.
  Fixture `module-evaluation` pins all of it, including that function-body changes stay as narrow as before.

### Seeds
Changed files are compared **structurally**, not by mapping diff hunks to line spans. Each symbol's `bodyHash` (tokens
without comments/whitespace) and export status, plus the file's `moduleHash`, are compared between base and head. A
changed symbol seeds itself. A changed `moduleHash` seeds `<module>`, which reaches every symbol of the file. Equal
hashes seed nothing, so comment-only, whitespace-only and moved-code edits select no tests. Hunk mapping would need a
git call per file, has line-range edge cases, and misreads moved code.

## Consequences
- ✅ `barrel-hell`: 4/3/3 tests at file level → 2/1/0 at symbol level. A comment-only edit selects nothing.
- ✅ Symbol ⊆ file on every golden scenario. File level stays available (`--granularity file`).
- ⚠️ Module-level edits (imports, top-level statements, effectful initializers) reach everything that loads the module,
  transitively, including through barrels: the barrel precision win holds for function and class bodies only.
- ✅ Code that runs while a class is defined (decorators, static blocks, and static initializers, computed member names
  and `extends` expressions that run code) gets its own effectful `Class.<load>` symbol, so it reaches everything that
  loads the file, while a method body stays as narrow as before. `@dec export class A` needed this most: the decorator
  sits on the export statement, so no hash covered it and an edit there selected nothing.
- ⚠️ A class expression with load-time code (`const A = class { static { … } }`) has no `<load>` symbol: the whole
  initializer counts as effectful, so its method bodies reach every loader too.
- ⚠️ Known widening: using a class pulls in all its methods. Type-aware method binding (TS Compiler API precision mode)
  could narrow this later.
- ⚠️ Unused named imports create no edge. A module whose *top-level side effects* change does reach importers that
  reference any of its symbols, but not one that imports a symbol and never uses it.
