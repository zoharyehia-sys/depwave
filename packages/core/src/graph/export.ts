import { nodeId } from '../model/ids.js';
import { findImportCycles } from './cycles.js';
import { NO_PACKAGE, type DependencyGraph } from './DependencyGraph.js';

export type GraphLevel = 'package' | 'file';

export interface ExportedNode {
  /** Package name, or repo-relative file path. Unique within an export. */
  id: string;
  kind: 'package' | 'file';
  /** Test file (file level only). */
  test?: boolean;
  /** Part of an import cycle (file level only). */
  inCycle?: boolean;
}

export interface ExportedEdge {
  from: string;
  to: string;
  /** `depends`: a declared workspace dependency. `imports` / `dynamic` / `type`: a file import of that kind. */
  kind: 'depends' | 'imports' | 'dynamic' | 'type';
}

export interface ExportedGraph {
  level: GraphLevel;
  /** File level: the package the export was limited to. */
  package?: string;
  nodes: ExportedNode[];
  edges: ExportedEdge[];
}

export interface ExportOptions {
  level: GraphLevel;
  /** File level: only this package's files. Imports that leave it point at the target package instead. */
  package?: string;
}

/** A small, renderer-neutral projection of the graph for `depwave graph`: sorted, so output is stable. */
export function exportGraph(graph: DependencyGraph, options: ExportOptions): ExportedGraph {
  return options.level === 'package' ? packageLevel(graph) : fileLevel(graph, options.package);
}

function packageLevel(graph: DependencyGraph): ExportedGraph {
  const nodes = [...graph.packages()].map((p): ExportedNode => ({ id: p.name, kind: 'package' }));
  const edges: ExportedEdge[] = [];
  for (const pkg of graph.packages()) {
    for (const edge of graph.outEdges(pkg.id)) {
      const target = graph.node(edge.to);
      if (edge.kind === 'DEPENDS_ON' && target?.kind === 'package') edges.push({ from: pkg.name, to: target.name, kind: 'depends' });
    }
  }
  return { level: 'package', nodes: sortNodes(nodes), edges: sortEdges(edges) };
}

function fileLevel(graph: DependencyGraph, only: string | undefined): ExportedGraph {
  const scope = only === undefined ? undefined : nodeId.package(only);
  if (scope !== undefined && !graph.node(scope)) throw new Error(`no workspace package named ${only}`);
  const inScope = (packageId: string | undefined) => scope === undefined || (packageId ?? NO_PACKAGE) === scope;
  const cyclic = new Set(findImportCycles(graph).flatMap((c) => c.files));

  const nodes = new Map<string, ExportedNode>();
  const edges = new Map<string, ExportedEdge>();
  for (const file of graph.nodes('file')) {
    if (!inScope(file.packageId)) continue;
    nodes.set(file.path, { id: file.path, kind: 'file', ...(file.isTest ? { test: true } : {}), ...(cyclic.has(file.path) ? { inCycle: true } : {}) });
    for (const edge of graph.outEdges(file.id)) {
      if (edge.kind !== 'IMPORTS' && edge.kind !== 'RE_EXPORTS' && edge.kind !== 'DYNAMIC_IMPORT') continue;
      const target = graph.node(edge.to);
      if (target?.kind !== 'file' || target.path === file.path) continue;
      const kind: ExportedEdge['kind'] = edge.kind === 'DYNAMIC_IMPORT' ? 'dynamic' : edge.typeOnly ? 'type' : 'imports';
      let to = target.path;
      if (!inScope(target.packageId)) {
        const pkg = target.packageId === undefined ? undefined : graph.node(target.packageId);
        to = pkg?.kind === 'package' ? pkg.name : '(no package)';
        nodes.set(to, { id: to, kind: 'package' });
      }
      // One edge per pair: the strongest kind wins (a runtime import beats a dynamic or type-only one).
      const key = `${file.path}\u0000${to}`;
      const existing = edges.get(key);
      if (!existing || rank(kind) > rank(existing.kind)) edges.set(key, { from: file.path, to, kind });
    }
  }
  return { level: 'file', ...(only === undefined ? {} : { package: only }), nodes: sortNodes([...nodes.values()]), edges: sortEdges([...edges.values()]) };
}

const rank = (kind: ExportedEdge['kind']) => ['type', 'dynamic', 'imports', 'depends'].indexOf(kind);
const sortNodes = (nodes: ExportedNode[]) => nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const sortEdges = (edges: ExportedEdge[]) => edges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
