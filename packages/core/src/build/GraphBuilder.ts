import { DependencyGraph, NO_PACKAGE } from '../graph/DependencyGraph.js';
import type { FileFacts, ImportFact, SymbolFact } from '../model/facts.js';
import { Confidence, MODULE_SYMBOL, type EdgeKind, type FileNode, type Granularity } from '../model/graph.js';
import { nodeId, type NodeId } from '../model/ids.js';
import type { UnresolvedImport } from '../model/impact.js';
import type { Inventory, WorkspacePackage } from '../model/workspace.js';
import { dirOf, isTestPath, isWithin, resolveRelative } from '../paths.js';
import type { ResolverPort } from '../ports/resolver.js';
import { ReExportResolver } from './ReExportResolver.js';

/** Bump whenever linking output can change for the same inputs: it's part of every snapshot cache key. */
export const GRAPH_VERSION = 4;

/** Modules that start processes or workers: a test using them can execute any file of its package. */
const SPAWN_MODULES = new Set([
  'child_process',
  'node:child_process',
  'worker_threads',
  'node:worker_threads',
  'execa',
  'tinyexec',
  'cross-spawn',
  'zx',
  'nano-spawn',
]);

export interface GraphBuildInput {
  inventory: Inventory;
  /** Facts per source file path. Files without facts become nodes without outgoing edges. */
  facts: ReadonlyMap<string, FileFacts>;
  resolver: ResolverPort;
  isTestFile?: (path: string) => boolean;
  /** Default 'file' (Phase 1 graph). 'symbol' adds symbols, references and barrel-chased bindings. */
  granularity?: Granularity;
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
 *
 * Symbol granularity replaces the file-to-file import edges with (ARCHITECTURE.md §2.4):
 *
 *  file:F ─PART_OF→ sym:F#X           "any part of F" changes when any of its symbols does
 *  sym:F#X ─IN_MODULE→ sym:F#<module> every symbol depends on its file's top-level code
 *  sym ─CALLS/REFERENCES→ sym          references, bound through imports and barrels to the DEFINING symbol
 *  sym ─REFERENCES→ file               when the binding can't be known statically (namespace used as a value, assets)
 *  sym|<module> ─IMPORTS/DYNAMIC_IMPORT→ file   side-effect imports, bare require(), import() from the enclosing symbol
 *  file ─RE_EXPORTS→ file              kept, so whole-module users of a barrel still see changes behind it
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
  private readonly granularity: Granularity;
  private readonly resolutions = new Map<string, string | undefined>();
  private readonly binder: ReExportResolver;

  constructor(private readonly input: GraphBuildInput) {
    this.isTestFile = input.isTestFile ?? isTestPath;
    this.granularity = input.granularity ?? 'file';
    this.binder = new ReExportResolver({ facts: input.facts, resolve: (from, specifier) => this.resolvePath(from, specifier) });
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
      if (facts) this.linkRuntimeDependencies(file.path, facts);
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
    if (this.granularity === 'symbol') return this.linkSymbols(path, facts);
    const from = nodeId.file(path);
    for (const fact of facts.imports) this.linkImport(path, from, fact);
    for (const fact of facts.exports) {
      if (fact.from === undefined) continue;
      this.linkSpecifier(path, from, fact.from, 'RE_EXPORTS', fact.typeOnly);
    }
  }

  /**
   * Dependencies no import expresses. A test that spawns processes (`child_process`, `execa`, …) can run any code of
   * its package (a CLI test runs the package's bin), and a file whose extraction crashed may import anything: both get
   * the "may load anything in its package" wildcard that `import(expr)` gets.
   */
  private linkRuntimeDependencies(path: string, facts: FileFacts): void {
    const spawns = this.isTestFile(path) && facts.imports.some((i) => i.specifier !== undefined && SPAWN_MODULES.has(i.specifier));
    if (!spawns && facts.failed === undefined) return;
    const fileId = nodeId.file(path);
    const node = this.graph.node(fileId);
    this.graph.addWildcardDependency((node?.kind === 'file' && node.packageId) || NO_PACKAGE, fileId);
  }

  // ─── symbol granularity ──────────────────────────────────────────────────────

  private linkSymbols(path: string, facts: FileFacts): void {
    const fileId = nodeId.file(path);
    const moduleId = nodeId.symbol(path, MODULE_SYMBOL);
    const names = new Set(facts.symbols.map((s) => s.name));
    const nodeFor = (name: string | undefined) => (name !== undefined && names.has(name) ? nodeId.symbol(path, name) : moduleId);

    const moduleSpan = { startLine: 1, endLine: 1, startByte: 0, endByte: 0 };
    this.addSymbol(path, moduleId, { name: MODULE_SYMBOL, kind: 'module', exported: false, span: moduleSpan, bodyHash: facts.moduleHash });
    for (const symbol of facts.symbols) {
      const id = nodeId.symbol(path, symbol.name);
      this.addSymbol(path, id, symbol);
      this.edge(id, moduleId, 'IN_MODULE', fileId);
      // A class depends on all its members. Methods are mostly called on instances (often typed as an interface),
      // which syntax alone can't bind: whoever uses the class must see any of its methods change.
      if (symbol.parent !== undefined && names.has(symbol.parent)) this.edge(nodeId.symbol(path, symbol.parent), id, 'PART_OF', fileId);
    }

    for (const fact of facts.imports) {
      const from = nodeFor(fact.from);
      if (fact.kind === 'dynamic') {
        this.linkImport(path, from, fact, fileId);
      } else if (fact.specifier !== undefined && (fact.kind === 'side-effect' || fact.bindings.length === 0)) {
        this.linkSpecifier(path, from, fact.specifier, 'IMPORTS', false, fileId); // import './x'; require('./x')
      } else if (fact.specifier !== undefined) {
        this.reportIfUnresolved(path, fact.specifier); // bindings become edges through the references that use them
      } else {
        this.linkImport(path, from, fact, fileId); // require(expr)
      }
    }
    for (const fact of facts.exports) {
      if (fact.from !== undefined) this.linkSpecifier(path, fileId, fact.from, 'RE_EXPORTS', fact.typeOnly, fileId);
    }

    for (const ref of facts.references) {
      const source = nodeFor(ref.from);
      const [root = '', member] = ref.to.split('.');
      const local = member !== undefined && names.has(`${root}.${member}`) ? `${root}.${member}` : root;
      const target = names.has(root) ? { kind: 'symbol' as const, id: nodeId.symbol(path, local) } : this.binder.imported(path, root, member);
      if (!target || target.id === source) continue;
      if (target.kind === 'module') {
        const targetPath = target.id.slice('file:'.length);
        this.addFile(targetPath, this.sourceDetails(targetPath));
      }
      const typeOnly = ref.kind === 'type' || this.binder.isTypeOnlyBinding(path, root);
      this.edge(source, target.id, ref.kind === 'call' ? 'CALLS' : 'REFERENCES', fileId, typeOnly);
    }
  }

  private addSymbol(path: string, id: NodeId, symbol: SymbolFact): void {
    const fileId = nodeId.file(path);
    this.graph.addNode({
      id,
      kind: 'symbol',
      fileId,
      name: symbol.name,
      symbolKind: symbol.kind,
      exported: symbol.exported,
      span: symbol.span,
      bodyHash: symbol.bodyHash,
    });
    this.edge(fileId, id, 'PART_OF', fileId);
  }

  private edge(from: NodeId, to: NodeId, kind: EdgeKind, ownerFile: NodeId, typeOnly = false): void {
    this.graph.addEdge({ from, to, kind, confidence: Confidence.certain, ownerFile, ...(typeOnly ? { typeOnly } : {}) });
  }

  private reportIfUnresolved(path: string, specifier: string): void {
    const result = this.input.resolver.resolve(path, specifier);
    if (result.kind === 'unresolved') this.unresolved.push({ from: path, specifier, reason: result.reason });
  }

  /** Resolved repository path for a specifier, memoized (the binder asks for the same pairs repeatedly). */
  private resolvePath(from: string, specifier: string): string | undefined {
    const key = `${from}\u0000${specifier}`;
    if (!this.resolutions.has(key)) {
      const result = this.input.resolver.resolve(from, specifier);
      this.resolutions.set(key, result.kind === 'file' ? result.path : undefined);
    }
    return this.resolutions.get(key);
  }

  // ─── shared ──────────────────────────────────────────────────────────────────

  private linkImport(path: string, from: NodeId, fact: ImportFact, ownerFile: NodeId = from): void {
    const kind: EdgeKind = fact.kind === 'dynamic' ? 'DYNAMIC_IMPORT' : 'IMPORTS';
    const typeOnly = fact.kind === 'type' || (fact.bindings.length > 0 && fact.bindings.every((b) => b.typeOnly));

    if (fact.specifier !== undefined) {
      this.linkSpecifier(path, from, fact.specifier, kind, typeOnly, ownerFile);
    } else if (fact.pattern !== undefined && (fact.pattern.startsWith('./') || fact.pattern.startsWith('../'))) {
      this.linkPattern(path, from, fact.pattern, ownerFile);
    } else {
      // Fully dynamic (or a non-relative glob): `from` may load any module in its package.
      const node = this.graph.node(ownerFile);
      this.graph.addWildcardDependency((node?.kind === 'file' && node.packageId) || NO_PACKAGE, from);
    }
  }

  private linkSpecifier(path: string, from: NodeId, specifier: string, kind: EdgeKind, typeOnly: boolean, ownerFile: NodeId = from): void {
    const result = this.input.resolver.resolve(path, specifier);
    if (result.kind === 'unresolved') {
      this.unresolved.push({ from: path, specifier, reason: result.reason });
      return;
    }
    if (result.kind !== 'file') return; // third-party and builtins: lockfile triggers cover them
    const to = this.addFile(result.path, this.sourceDetails(result.path));
    if (to === from) return;
    this.graph.addEdge({ from, to, kind, confidence: Confidence.certain, ownerFile, ...(typeOnly ? { typeOnly } : {}) });
  }

  /** `./locales/*.ts` → every tracked file it matches. A template may contain '/', so '*' spans directories. */
  private linkPattern(path: string, from: NodeId, pattern: string, ownerFile: NodeId = from): void {
    const absolute = resolveRelative(dirOf(path), pattern);
    if (absolute === undefined) return;
    const matcher = globToRegExp(absolute);
    const staticDir = dirOf(absolute.slice(0, absolute.indexOf('*') + 1));
    for (const candidate of this.input.inventory.paths) {
      if (!isWithin(candidate, staticDir) || !matcher.test(candidate)) continue;
      const to = this.addFile(candidate, this.sourceDetails(candidate));
      if (to === from) continue;
      this.graph.addEdge({ from, to, kind: 'DYNAMIC_IMPORT', confidence: Confidence.likely, ownerFile, meta: { pattern } });
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
