import type { NodeId } from './ids.js';

export type LanguageId = 'typescript' | 'tsx' | 'javascript' | 'jsx' | 'python';

export type NodeKind = 'package' | 'file' | 'symbol' | 'test' | 'external' | 'unresolved';

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'variable'
  | 'type'
  | 'interface'
  | 'enum'
  | 'component'
  /** `<module>`: a file's top-level code (imports, side effects). Every symbol of the file depends on it. */
  | 'module';

/** `file`: Phase 1 file-level graph. `symbol`: symbols, references and barrel-chased bindings (Phase 2). */
export type Granularity = 'file' | 'symbol';

/** Name of the pseudo-symbol for a file's top-level code. */
export const MODULE_SYMBOL = '<module>';

export interface Span {
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
}

interface BaseNode {
  id: NodeId;
  kind: NodeKind;
}

export interface PackageNode extends BaseNode {
  kind: 'package';
  name: string;
  /** Repo-relative POSIX path of the package root. */
  root: string;
  manifestPath: string;
}

export interface FileNode extends BaseNode {
  kind: 'file';
  path: string;
  /** Owning package; absent for files outside every package. */
  packageId?: NodeId;
  /** Absent for non-source files that are imported (styles, JSON, assets): they still need nodes so edits to them count. */
  language?: LanguageId;
  /** Git blob OID for source files (dirty/untracked files are hashed with `git hash-object`); '' for assets. */
  contentHash: string;
  isTest: boolean;
  /** Top-level statements beyond declarations and imports. */
  hasSideEffects: boolean;
}

export interface SymbolNode extends BaseNode {
  kind: 'symbol';
  fileId: NodeId;
  /** Dotted for members, e.g. `UserService.save`. */
  name: string;
  symbolKind: SymbolKind;
  exported: boolean | 'default';
  span: Span;
  /** Hash of the symbol's normalized text (comments and whitespace stripped). */
  bodyHash: string;
}

export type TestFramework = 'vitest' | 'jest' | 'pytest' | 'playwright' | 'unknown';

export interface TestNode extends BaseNode {
  kind: 'test';
  fileId: NodeId;
  framework: TestFramework;
  /** describe/it title, for per-test-case selection (Phase 3). */
  name?: string;
}

export interface ExternalNode extends BaseNode {
  kind: 'external';
  specifier: string;
  version?: string;
}

export type UnresolvedReason = 'dynamic-expression' | 'not-found' | 'unsupported-syntax';

export interface UnresolvedNode extends BaseNode {
  kind: 'unresolved';
  reason: UnresolvedReason;
  raw: string;
}

export type GraphNode = PackageNode | FileNode | SymbolNode | TestNode | ExternalNode | UnresolvedNode;

/**
 * Every edge points from the dependent to its dependency. Impact walks them backwards.
 * In symbol granularity, `file:F` means "any part of F" and `sym:F#<module>` means F's top-level code.
 */
export type EdgeKind =
  | 'CONTAINS' // package→file
  | 'IMPORTS' // file|symbol→file: module-level dependency (side-effect import, require, unbindable import)
  | 'IMPORTS_SYMBOL' // reserved: file→symbol binding
  | 'RE_EXPORTS' // file→file (barrels: `export … from`)
  | 'CALLS' // symbol→symbol
  | 'REFERENCES' // symbol→symbol|file (extends, JSX, type refs, value use, whole-namespace use)
  | 'DYNAMIC_IMPORT' // file|symbol→file (import(), lazy())
  | 'DEPENDS_ON' // package→package
  | 'PART_OF' // file:F→sym:F#X: "any part of F" changes when any symbol or the module scope changes
  | 'IN_MODULE' // sym:F#X→sym:F#<module>: a symbol depends on its file's top-level code
  | 'TESTS'; // test→file|symbol

/** Ordered weakest → strongest so `Math.min` gives weakest-link confidence along a path. */
export const Confidence = { heuristic: 0, likely: 1, certain: 2 } as const;
export type Confidence = (typeof Confidence)[keyof typeof Confidence];

export interface SourceLocation {
  line: number;
  col: number;
}

export interface GraphEdge {
  from: NodeId;
  to: NodeId;
  kind: EdgeKind;
  confidence: Confidence;
  /** File whose contents produced this edge: the key to incremental invalidation. */
  ownerFile: NodeId;
  /** `import type`: excluded from runtime impact, included for type-check impact. */
  typeOnly?: boolean;
  loc?: SourceLocation;
  meta?: {
    /** Glob for template-literal dynamic imports, e.g. `./locales/*.ts`. */
    pattern?: string;
    /** Barrel files traversed to reach the defining symbol. */
    viaReExport?: NodeId[];
  };
}
