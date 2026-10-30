import type { LanguageId, SourceLocation, Span, SymbolKind } from './graph.js';

/**
 * Everything the parser knows about ONE file, with zero cross-file knowledge.
 * A pure function of (content, language, parserVersion), hence cacheable forever by content hash.
 */
export interface FileFacts {
  path: string;
  language: LanguageId;
  contentHash: string;
  parserVersion: string;
  imports: ImportFact[];
  exports: ExportFact[];
  symbols: SymbolFact[];
  references: ReferenceFact[];
  hasSideEffects: boolean;
  /**
   * Token hash of everything at the top level that is NOT a symbol declaration (imports, export clauses, top-level
   * statements), without comments. Equal hashes mean a diff outside every symbol changed nothing that runs.
   */
  moduleHash: string;
  /** Count of Tree-sitter ERROR nodes: facts are best-effort when > 0. */
  parseErrors: number;
  /**
   * Set when extraction crashed for this file (e.g. a pathological generated file). The facts are then empty, and the
   * file is treated conservatively: it may depend on anything in its package, and any change to it is a whole-file change.
   */
  failed?: string;
}

export type ImportKind = 'static' | 'type' | 'dynamic' | 'require' | 'side-effect';

export interface ImportBinding {
  /** Exported name in the target module; `default` and `*` (namespace / whole CommonJS module) are special. */
  imported: string;
  local: string;
  /** `import { type A, b }`: this binding alone is type-only. */
  typeOnly?: boolean;
}

export interface ImportFact {
  kind: ImportKind;
  /** Literal specifier, or undefined when the expression is fully dynamic (`import(name)`). */
  specifier?: string;
  /** Glob for template literals with a static prefix: import(`./locales/${l}.ts`) → `./locales/*.ts`. */
  pattern?: string;
  bindings: ImportBinding[];
  /** Enclosing symbol for imports inside code (`import()` / `require()` in a function). Absent = top level. */
  from?: string;
  loc: SourceLocation;
}

export type ExportKind = 'local' | 'reexport' | 'reexport-all' | 'reexport-namespace';

export interface ExportFact {
  kind: ExportKind;
  /** Exported name; `default` for default exports, `*` for `export * from`. */
  name: string;
  /** Local symbol name for `export { a as b }` and plain local exports. */
  local?: string;
  /** Specifier for re-exports. */
  from?: string;
  typeOnly: boolean;
}

export interface SymbolFact {
  /** Top-level name, `Class.method` for members, `Class.<load>` for code run while the class is defined, or `default` for anonymous default exports. */
  name: string;
  kind: SymbolKind;
  exported: boolean | 'default';
  /** Lines are 1-based and inclusive. Includes the `export` keyword when the statement declares only this symbol. */
  span: Span;
  /** Hash of the token stream without comments: whitespace/comment-only edits don't change it. */
  bodyHash: string;
  /** Enclosing symbol for members, e.g. the class of a method. */
  parent?: string;
  /**
   * Its initializer runs code when the module loads (`const handler = register('x')`): loading the module, not using
   * the symbol, is what exposes a change to it.
   */
  effectful?: true;
}

export type ReferenceKind = 'call' | 'reference' | 'jsx' | 'extends' | 'type';

export interface ReferenceFact {
  kind: ReferenceKind;
  /** Enclosing symbol name, or `<module>` for top-level code. */
  from: string;
  /** Local identifier as written, possibly dotted (`ns.fn`, `this.save`). */
  to: string;
  loc: SourceLocation;
}
