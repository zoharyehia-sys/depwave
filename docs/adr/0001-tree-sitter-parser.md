# ADR 0001: Tree-sitter as the primary parser

- **Status:** Accepted (amended 2026-10-26: WASM runtime, walker-based extraction)
- **Date:** 2026-10-26

## Context
We need fast, error-tolerant extraction of imports, exports, symbols and references across several languages (TS/JS first, Python next).

## Decision
Use Tree-sitter behind a `LanguageAdapter` port.

- **Runtime: `web-tree-sitter` (WASM)**, with grammars loaded from the `.wasm` files their npm packages ship.
  The original plan was native bindings with a WASM fallback. Shipping WASM only means no node-gyp, no prebuilt
  binaries per OS/arch, identical behaviour on Windows/Linux/macOS, and it runs in worker threads. Measured
  throughput (~3.5 MB/s single-threaded, including multi-MB bundles) is well within budget. Native bindings stay
  an option behind the same `GrammarId` seam if profiling ever demands it.
- **Extraction: a typed two-pass tree walk per language family**, not `.scm` queries. Imports, exports and
  declarations live at the top level, where a walk is simpler and easier to read than queries. References need
  scope context (enclosing symbol, enclosing class for `this.x()`, module-scope bindings), which queries can't
  express. Queries remain an option for simple languages.
- **One adapter class for the JS family:** `.ts` uses the TypeScript grammar (where `<T>x` is a cast). `.tsx/.js/.jsx`
  use the TSX grammar, which parses plain JS and JSX.

Type-aware resolution, when needed, is an opt-in "precision mode" on the TypeScript Compiler API.

## Consequences
- ✅ One runtime for every language, no native toolchain anywhere. Parses broken code (errors are counted, not fatal).
- ✅ Extraction logic is plain TypeScript, unit-tested against a snippet corpus and every fixture.
- ⚠️ Syntax only: cross-file semantics come from the resolver and link phase.
- ⚠️ WASM trees must be freed explicitly (`tree.delete()`); `ASTParser` does this right after extraction.
- ⚠️ Grammar gaps exist (e.g. one construct in TypeScript's own `lib.es2015.symbol.wellknown.d.ts`). They show up as `parseErrors > 0`, and extraction degrades gracefully.

## Alternatives
Babel (JS-only, imperative visitors), native per-language ASTs (one runtime per language), oxc-parser (fast but JS-only),
native `tree-sitter` bindings (faster, but a native build matrix to maintain).
