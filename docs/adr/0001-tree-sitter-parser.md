# ADR 0001: Tree-sitter as the primary parser

- **Status:** Accepted
- **Date:** 2026-10-26

## Context
We need fast, error-tolerant extraction of imports, exports, symbols and references across several languages (TS/JS first, Python next).

## Decision
Use Tree-sitter (native bindings, WASM fallback) with per-language `.scm` queries behind a `LanguageAdapter` port.
Type-aware resolution, when needed, is an opt-in "precision mode" on the TypeScript Compiler API.

## Consequences
- ✅ One API for every language; language support is mostly data. Parses broken code. Built-in incremental re-parse for watch mode.
- ⚠️ Syntax only: cross-file semantics must come from the resolver and link phase.
- ⚠️ Native addon: needs prebuilt binaries and the WASM fallback for exotic platforms and worker threads.

## Alternatives
Babel (JS-only, imperative visitors), native per-language ASTs (one runtime per language), oxc-parser (fast but JS-only).
