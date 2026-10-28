import type { FileNode, GraphEdge, GraphNode, PackageNode } from '../model/graph.js';
import type { NodeId } from '../model/ids.js';
import type { GraphSnapshot } from '../model/snapshot.js';

/** Wildcard scope for files that belong to no package. */
export const NO_PACKAGE: NodeId = 'pkg:<none>';

/** Read-only view the impact algorithms run on: one graph, or the union of a base and a head graph. */
export interface GraphView {
  node(id: NodeId): GraphNode | undefined;
  /** Edges pointing AT `id` (its dependents). */
  inEdges(id: NodeId): Iterable<GraphEdge>;
  /** Files that may load anything in `scope` (they contain a fully dynamic import). */
  wildcardDependents(scope: NodeId): Iterable<NodeId>;
}

const edgeKey = (e: Pick<GraphEdge, 'from' | 'to' | 'kind'>) => `${e.from}\u0000${e.to}\u0000${e.kind}`;

/**
 * Nodes and edges with forward and reverse indexes. Every edge records the file whose contents produced it
 * (`ownerFile`), so an edit to one file can drop exactly that file's edges (the incremental update primitive).
 */
export class DependencyGraph implements GraphView {
  private readonly nodeMap = new Map<NodeId, GraphNode>();
  private readonly outMap = new Map<NodeId, Map<string, GraphEdge>>();
  private readonly inMap = new Map<NodeId, Map<string, GraphEdge>>();
  private readonly owned = new Map<NodeId, Set<string>>();
  private readonly edges = new Map<string, GraphEdge>();
  private readonly wildcards = new Map<NodeId, Set<NodeId>>();

  addNode(node: GraphNode): void {
    this.nodeMap.set(node.id, node);
  }

  node(id: NodeId): GraphNode | undefined {
    return this.nodeMap.get(id);
  }

  *nodes<K extends GraphNode['kind']>(kind?: K): Iterable<Extract<GraphNode, { kind: K }>> {
    for (const node of this.nodeMap.values()) {
      if (kind === undefined || node.kind === kind) yield node as Extract<GraphNode, { kind: K }>;
    }
  }

  get nodeCount(): number {
    return this.nodeMap.size;
  }

  get edgeCount(): number {
    return this.edges.size;
  }

  /** Idempotent: one edge per (from, to, kind). A later add of the same edge keeps the first. */
  addEdge(edge: GraphEdge): void {
    const key = edgeKey(edge);
    if (this.edges.has(key)) return;
    this.edges.set(key, edge);
    bucket(this.outMap, edge.from).set(key, edge);
    bucket(this.inMap, edge.to).set(key, edge);
    let owned = this.owned.get(edge.ownerFile);
    if (!owned) this.owned.set(edge.ownerFile, (owned = new Set()));
    owned.add(key);
  }

  outEdges(id: NodeId): Iterable<GraphEdge> {
    return this.outMap.get(id)?.values() ?? [];
  }

  inEdges(id: NodeId): Iterable<GraphEdge> {
    return this.inMap.get(id)?.values() ?? [];
  }

  /** Removes every edge and wildcard produced by `fileId`'s contents, in O(edges owned). Returns how many edges went. */
  removeEdgesOwnedBy(fileId: NodeId): number {
    const keys = this.owned.get(fileId);
    for (const key of keys ?? []) {
      const edge = this.edges.get(key)!;
      this.edges.delete(key);
      this.outMap.get(edge.from)?.delete(key);
      this.inMap.get(edge.to)?.delete(key);
    }
    this.owned.delete(fileId);
    for (const dependents of this.wildcards.values()) dependents.delete(fileId);
    return keys?.size ?? 0;
  }

  addWildcardDependency(scope: NodeId, fileId: NodeId): void {
    let dependents = this.wildcards.get(scope);
    if (!dependents) this.wildcards.set(scope, (dependents = new Set()));
    dependents.add(fileId);
  }

  wildcardDependents(scope: NodeId): Iterable<NodeId> {
    return this.wildcards.get(scope) ?? [];
  }

  /** Files a package contains (via CONTAINS edges). */
  /** Files of a package; NO_PACKAGE yields the files outside every package (they have no CONTAINS edge). */
  *filesOf(packageId: NodeId): Iterable<FileNode> {
    if (packageId === NO_PACKAGE) {
      for (const node of this.nodes('file')) if (node.packageId === undefined) yield node;
      return;
    }
    for (const edge of this.outEdges(packageId)) {
      const node = this.nodeMap.get(edge.to);
      if (edge.kind === 'CONTAINS' && node?.kind === 'file') yield node;
    }
  }

  packages(): Iterable<PackageNode> {
    return this.nodes('package');
  }

  /** Plain-data form for persistence. Order is insertion order, so serialize → load round-trips exactly. */
  toData(): Pick<GraphSnapshot, 'nodes' | 'edges' | 'wildcards'> {
    return {
      nodes: [...this.nodeMap.values()],
      edges: [...this.edges.values()],
      wildcards: [...this.wildcards].map(([scope, dependents]) => [scope, [...dependents]]),
    };
  }

  static fromData(data: Pick<GraphSnapshot, 'nodes' | 'edges' | 'wildcards'>): DependencyGraph {
    const graph = new DependencyGraph();
    for (const node of data.nodes) graph.addNode(node);
    for (const edge of data.edges) graph.addEdge(edge);
    for (const [scope, dependents] of data.wildcards) for (const id of dependents) graph.addWildcardDependency(scope, id);
    return graph;
  }
}

/** Union of two graphs, typically head ∪ base: anything that depended on a changed thing in EITHER version is impacted. */
export class UnionGraph implements GraphView {
  constructor(private readonly graphs: readonly GraphView[]) {}

  node(id: NodeId): GraphNode | undefined {
    for (const graph of this.graphs) {
      const node = graph.node(id);
      if (node) return node;
    }
    return undefined;
  }

  *inEdges(id: NodeId): Iterable<GraphEdge> {
    const seen = new Set<string>();
    for (const graph of this.graphs) {
      for (const edge of graph.inEdges(id)) {
        const key = edgeKey(edge);
        if (!seen.has(key)) {
          seen.add(key);
          yield edge;
        }
      }
    }
  }

  *wildcardDependents(scope: NodeId): Iterable<NodeId> {
    const seen = new Set<NodeId>();
    for (const graph of this.graphs) {
      for (const id of graph.wildcardDependents(scope)) {
        if (!seen.has(id)) {
          seen.add(id);
          yield id;
        }
      }
    }
  }
}

function bucket(map: Map<NodeId, Map<string, GraphEdge>>, id: NodeId): Map<string, GraphEdge> {
  let edges = map.get(id);
  if (!edges) map.set(id, (edges = new Map()));
  return edges;
}
