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
  | 'component';

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
  manifestHash: string;
}

export interface FileNode extends BaseNode {
  kind: 'file';
  path: string;
  packageId: NodeId;
  language: LanguageId;
  /** Git blob OID for tracked files, xxh3-128 for dirty/untracked ones. */
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

export type EdgeKind =
  | 'CONTAINS' // package→file, file→symbol, class→method
  | 'IMPORTS' // file→file (module level)
  | 'IMPORTS_SYMBOL' // file→symbol (bound to the defining symbol, after re-export chasing)
  | 'RE_EXPORTS' // file→symbol|file (barrels)
  | 'CALLS' // symbol→symbol
  | 'REFERENCES' // symbol→symbol (extends, JSX, type refs, non-call usage)
  | 'DYNAMIC_IMPORT' // file→file|unresolved (import(), require(expr), lazy())
  | 'DEPENDS_ON' // package→package|external
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
