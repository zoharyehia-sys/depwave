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
  /** Count of Tree-sitter ERROR nodes: facts are best-effort when > 0. */
  parseErrors: number;
}

export type ImportKind = 'static' | 'type' | 'dynamic' | 'require' | 'side-effect';

export interface ImportBinding {
  /** Exported name in the target module; `default` and `*` (namespace) are special. */
  imported: string;
  local: string;
}

export interface ImportFact {
  kind: ImportKind;
  /** Literal specifier, or undefined when the expression is fully dynamic (`import(name)`). */
  specifier?: string;
  /** Glob for template literals with a static prefix: import(`./locales/${l}.ts`) → `./locales/*.ts`. */
  pattern?: string;
  bindings: ImportBinding[];
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
  name: string;
  kind: SymbolKind;
  exported: boolean | 'default';
  span: Span;
  bodyHash: string;
  /** Enclosing symbol for members, e.g. the class of a method. */
  parent?: string;
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
