import { NO_PACKAGE, type GraphView } from '../graph/DependencyGraph.js';
import { Confidence, type EdgeKind } from '../model/graph.js';
import type { NodeId } from '../model/ids.js';
import type { ImpactedNode, ImpactPolicyOptions } from '../model/impact.js';

/**
 * Conservative by default: type-only imports are followed too (a changed type can break a test's compile step), and
 * fully dynamic imports widen to their whole package. Package-level edges (CONTAINS, DEPENDS_ON) are not walked here:
 * manifest changes are expanded into file seeds by the DiffAnalyzer.
 */
export const DEFAULT_POLICY: ImpactPolicyOptions = {
  mode: 'conservative',
  includeTypeOnly: true,
  followEdges: ['IMPORTS', 'RE_EXPORTS', 'DYNAMIC_IMPORT', 'IMPORTS_SYMBOL', 'CALLS', 'REFERENCES', 'PART_OF', 'IN_MODULE', 'TESTS'],
};

/** Per-hop decay for ranking. Ranking orders tests (fail fast); it never changes the impacted set. */
const DECAY = 0.85;

/**
 * Multi-source reverse BFS: everything that transitively depends on a seed. First visit = shortest path, recorded in
 * `via` for `depwave why`. Confidence is the weakest edge on the best path. O(reachable nodes + edges).
 */
export function predictImpact(graph: GraphView, seeds: readonly NodeId[], policy: ImpactPolicyOptions = DEFAULT_POLICY): ImpactedNode[] {
  const follow = new Set<EdgeKind>(policy.followEdges);
  const impacted = new Map<NodeId, ImpactedNode>();
  const queue: NodeId[] = [];

  const visit = (id: NodeId, from: ImpactedNode, edgeConfidence: Confidence) => {
    const confidence = Math.min(from.confidence, edgeConfidence) as Confidence;
    const existing = impacted.get(id);
    if (existing) {
      if (confidence > existing.confidence) {
        existing.confidence = confidence; // a later, equally-short or longer path may still be more certain
        existing.score = score(existing.distance, confidence);
      }
      return;
    }
    const distance = from.distance + 1;
    impacted.set(id, { id, distance, confidence, via: from.id, score: score(distance, confidence) });
    queue.push(id);
  };

  for (const seed of [...new Set(seeds)].sort()) {
    impacted.set(seed, { id: seed, distance: 0, confidence: Confidence.certain, score: 1 });
    queue.push(seed);
  }

  for (let head = 0; head < queue.length; head++) {
    const current = impacted.get(queue[head]!)!;
    if (policy.maxDepth !== undefined && current.distance >= policy.maxDepth) continue;

    for (const edge of graph.inEdges(current.id)) {
      if (!follow.has(edge.kind) || (edge.typeOnly && !policy.includeTypeOnly)) continue;
      visit(edge.from, current, edge.confidence);
    }

    // A file with `import(expr)` (or a spawning test) may load anything in its package: reaching any file there reaches
    // it too. Test files are excluded as the trigger: production code and spawned binaries don't load tests.
    const node = graph.node(current.id);
    if (policy.mode === 'conservative' && node?.kind === 'file' && !node.isTest) {
      for (const dependent of graph.wildcardDependents(node.packageId ?? NO_PACKAGE)) visit(dependent, current, Confidence.heuristic);
    }
  }

  return [...impacted.values()];
}

const score = (distance: number, confidence: Confidence): number => ((confidence + 1) / 3) * DECAY ** distance;

/** Shortest path from an impacted node back to the seed that reached it (inclusive), for explanations. */
export function explainPath(impacted: readonly ImpactedNode[], id: NodeId): NodeId[] {
  const byId = new Map(impacted.map((n) => [n.id, n]));
  const path: NodeId[] = [];
  for (let current = byId.get(id); current; current = current.via === undefined ? undefined : byId.get(current.via)) {
    path.push(current.id);
  }
  return path;
}
