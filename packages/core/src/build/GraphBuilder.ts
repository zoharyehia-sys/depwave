import { DependencyGraph, NO_PACKAGE } from '../graph/DependencyGraph.js';
import type { FileFacts, ImportFact } from '../model/facts.js';
import { Confidence, type EdgeKind, type FileNode } from '../model/graph.js';
import { nodeId, type NodeId } from '../model/ids.js';
import type { UnresolvedImport } from '../model/impact.js';
import type { Inventory, WorkspacePackage } from '../model/workspace.js';
import { dirOf, isTestPath, isWithin, resolveRelative } from '../paths.js';
import type { ResolverPort } from '../ports/resolver.js';

export interface GraphBuildInput {
  inventory: Inventory;
  /** Facts per source file path. Files without facts become nodes without outgoing edges. */
  facts: ReadonlyMap<string, FileFacts>;
  resolver: ResolverPort;
  isTestFile?: (path: string) => boolean;
}

export interface GraphBuildResult {
  graph: DependencyGraph;
  /** Imports that resolved to nothing: reported, never silently dropped. */
  unresolved: UnresolvedImport[];
}

/**
 * The link phase (file level): packages, files, and the edges between them.
 *
 *  package ─CONTAINS→ file          package ─DEPENDS_ON→ workspace package (from manifests)
 *  file ─IMPORTS→ file              static, type-only, side-effect and require imports
 *  file ─RE_EXPORTS→ file           `export … from`
 *  file ─DYNAMIC_IMPORT→ file       literal `import()` (certain) or every file a template glob matches (likely)
 *  wildcard                         `import(expr)`: the file may load anything in its own package (heuristic)
 *
 * Imported non-source files (styles, JSON, assets) get file nodes too, so editing them still has impact.
 */
export function buildGraph(input: GraphBuildInput): GraphBuildResult {
  return new Linker(input).link();
}

class Linker {
  private readonly graph = new DependencyGraph();
  private readonly unresolved: UnresolvedImport[] = [];
  private readonly isTestFile: (path: string) => boolean;
  /** Deepest-root-first, for owner lookup of files the inventory doesn't list (assets). */
  private readonly packagesByDepth: WorkspacePackage[];
  private readonly sources: ReadonlyMap<string, Inventory['files'][number]>;

  constructor(private readonly input: GraphBuildInput) {
    this.isTestFile = input.isTestFile ?? isTestPath;
    this.sources = new Map(input.inventory.files.map((f) => [f.path, f]));
    this.packagesByDepth = [...input.inventory.workspace.packages].sort((a, b) => b.root.length - a.root.length);
  }

  link(): GraphBuildResult {
    this.addPackages();
    for (const file of this.input.inventory.files) {
      const facts = this.input.facts.get(file.path);
      this.addFile(file.path, { language: file.language, contentHash: file.contentHash, hasSideEffects: facts?.hasSideEffects ?? false });
    }
    for (const file of this.input.inventory.files) {
      const facts = this.input.facts.get(file.path);
      if (facts) this.linkFile(file.path, facts);
    }
    return { graph: this.graph, unresolved: this.unresolved };
  }

  private addPackages(): void {
    const { packages } = this.input.inventory.workspace;
    const names = new Set(packages.map((p) => p.name));
    for (const pkg of packages) {
      this.graph.addNode({ id: nodeId.package(pkg.name), kind: 'package', name: pkg.name, root: pkg.root, manifestPath: pkg.manifestPath });
    }
    for (const pkg of packages) {
      for (const dependency of pkg.dependencies) {
        if (!names.has(dependency) || dependency === pkg.name) continue;
        this.graph.addEdge({
          from: nodeId.package(pkg.name),
          to: nodeId.package(dependency),
          kind: 'DEPENDS_ON',
          confidence: Confidence.certain,
          ownerFile: nodeId.file(pkg.manifestPath),
        });
      }
    }
  }

  private addFile(path: string, details: Pick<FileNode, 'contentHash' | 'hasSideEffects'> & { language?: FileNode['language'] }): NodeId {
    const id = nodeId.file(path);
    if (this.graph.node(id)) return id;

    const owner = this.ownerOf(path);
    const node: FileNode = { id, kind: 'file', path, contentHash: details.contentHash, isTest: this.isTestFile(path), hasSideEffects: details.hasSideEffects };
    if (details.language !== undefined) node.language = details.language;
    if (owner) node.packageId = nodeId.package(owner.name);
    this.graph.addNode(node);
    if (node.packageId) {
      this.graph.addEdge({ from: node.packageId, to: id, kind: 'CONTAINS', confidence: Confidence.certain, ownerFile: id });
    }
    return id;
  }

  private linkFile(path: string, facts: FileFacts): void {
    const from = nodeId.file(path);
    for (const fact of facts.imports) this.linkImport(path, from, fact);
    for (const fact of facts.exports) {
      if (fact.from === undefined) continue;
      this.linkSpecifier(path, from, fact.from, 'RE_EXPORTS', fact.typeOnly);
    }
  }

  private linkImport(path: string, from: NodeId, fact: ImportFact): void {
    const kind: EdgeKind = fact.kind === 'dynamic' ? 'DYNAMIC_IMPORT' : 'IMPORTS';
    const typeOnly = fact.kind === 'type' || (fact.bindings.length > 0 && fact.bindings.every((b) => b.typeOnly));

    if (fact.specifier !== undefined) {
      this.linkSpecifier(path, from, fact.specifier, kind, typeOnly);
    } else if (fact.pattern !== undefined && (fact.pattern.startsWith('./') || fact.pattern.startsWith('../'))) {
      this.linkPattern(path, from, fact.pattern);
    } else {
      // Fully dynamic (or a non-relative glob): this file may load any module in its package.
      const node = this.graph.node(from);
      this.graph.addWildcardDependency((node?.kind === 'file' && node.packageId) || NO_PACKAGE, from);
    }
  }

  private linkSpecifier(path: string, from: NodeId, specifier: string, kind: EdgeKind, typeOnly: boolean): void {
    const result = this.input.resolver.resolve(path, specifier);
    if (result.kind === 'unresolved') {
      this.unresolved.push({ from: path, specifier, reason: result.reason });
      return;
    }
    if (result.kind !== 'file') return; // third-party and builtins: lockfile triggers cover them
    const to = this.addFile(result.path, { contentHash: '', hasSideEffects: false });
    if (to === from) return;
    this.graph.addEdge({ from, to, kind, confidence: Confidence.certain, ownerFile: from, ...(typeOnly ? { typeOnly } : {}) });
  }

  /** `./locales/*.ts` → every tracked file it matches. A template may contain '/', so '*' spans directories. */
  private linkPattern(path: string, from: NodeId, pattern: string): void {
    const absolute = resolveRelative(dirOf(path), pattern);
    if (absolute === undefined) return;
    const matcher = globToRegExp(absolute);
    const staticDir = dirOf(absolute.slice(0, absolute.indexOf('*') + 1));
    for (const candidate of this.input.inventory.paths) {
      if (!isWithin(candidate, staticDir) || !matcher.test(candidate)) continue;
      const to = this.addFile(candidate, this.sourceDetails(candidate));
      if (to === from) continue;
      this.graph.addEdge({ from, to, kind: 'DYNAMIC_IMPORT', confidence: Confidence.likely, ownerFile: from, meta: { pattern } });
    }
  }

  private sourceDetails(path: string): { contentHash: string; hasSideEffects: boolean; language?: FileNode['language'] } {
    const source = this.sources.get(path);
    return source ? { contentHash: source.contentHash, hasSideEffects: false, language: source.language } : { contentHash: '', hasSideEffects: false };
  }

  private ownerOf(path: string): WorkspacePackage | undefined {
    return this.packagesByDepth.find((p) => isWithin(path, p.root));
  }
}

/**
 * Glob with `*` only (what the parser emits). A pattern without an extension (`./pages/*`) also matches files with
 * any extension and directory indexes, since bundlers resolve those.
 */
export function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.+');
  const hasExtension = /\.[^/*]+$/.test(pattern);
  return new RegExp(`^${body}${hasExtension ? '' : '(\\.[^/]+|/index\\.[^/]+)?'}$`);
}
