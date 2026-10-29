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
 * Multi-source reverse BFS: everything that transitively depends on a seed. The impacted SET is plain reachability
 * (within `maxDepth` hops). Confidence is the best weakest-link confidence over ALL paths (a longer certain path beats a
 * shorter heuristic one); `distance` is the shortest path with that confidence, and `via` its next node back.
 *
 * One BFS per confidence level, each following only edges at least that confident. A single walk that upgrades nodes
 * in place can't do this: an upgraded node's longer, more certain path is the wrong one for a dependent whose own edge
 * caps it lower anyway (x ─heuristic→ b ─heuristic→ leaf stays two hops after b is upgraded through x → a → b).
 */
export function predictImpact(graph: GraphView, seeds: readonly NodeId[], policy: ImpactPolicyOptions = DEFAULT_POLICY): ImpactedNode[] {
  const walks = LEVELS.map((level) => walk(graph, seeds, policy, level));
  const reachable = walks[0]!; // heuristic: every edge, so every reachable node
  return [...reachable.keys()].map((id) => {
    const level = LEVELS.findLastIndex((_, i) => walks[i]!.has(id));
    const { distance, via } = walks[level]!.get(id)!;
    const confidence = LEVELS[level]!;
    return { id, distance, confidence, ...(via === undefined ? {} : { via }), score: score(distance, confidence) };
  });
}

/**
 * The path that explains `node`'s confidence, from the node back to its seed (inclusive): the BFS at that confidence,
 * so its length is `node.distance`. Following `via` from node to node can be longer: each node's `via` is the best
 * path for ITS confidence, which may not be the shortest one at a dependent's lower confidence.
 */
export function explainPath(graph: GraphView, seeds: readonly NodeId[], node: ImpactedNode, policy: ImpactPolicyOptions = DEFAULT_POLICY): NodeId[] {
  const paths = walk(graph, seeds, policy, node.confidence, node.id);
  const path: NodeId[] = [];
  for (let id: NodeId | undefined = node.id; id !== undefined; id = paths.get(id)?.via) path.push(id);
  return path;
}

const LEVELS = [Confidence.heuristic, Confidence.likely, Confidence.certain] as const;

/** BFS over edges at least `minConfidence` confident; stops early once `target` is reached. */
function walk(graph: GraphView, seeds: readonly NodeId[], policy: ImpactPolicyOptions, minConfidence: Confidence, target?: NodeId): Map<NodeId, { distance: number; via?: NodeId }> {
  const follow = new Set<EdgeKind>(policy.followEdges);
  const reached = new Map<NodeId, { distance: number; via?: NodeId }>();
  const queue: NodeId[] = [];
  for (const seed of [...new Set(seeds)].sort()) {
    reached.set(seed, { distance: 0 });
    queue.push(seed);
  }
  const visit = (id: NodeId, from: NodeId, distance: number) => {
    if (reached.has(id)) return;
    reached.set(id, { distance, via: from });
    queue.push(id);
  };

  for (let head = 0; head < queue.length && !(target !== undefined && reached.has(target)); head++) {
    const id = queue[head]!;
    const distance = reached.get(id)!.distance + 1;
    if (policy.maxDepth !== undefined && distance > policy.maxDepth) continue;

    for (const edge of graph.inEdges(id)) {
      if (!follow.has(edge.kind) || (edge.typeOnly && !policy.includeTypeOnly) || edge.confidence < minConfidence) continue;
      visit(edge.from, id, distance);
    }

    // A file with `import(expr)` (or a spawning test) may load anything in its package: reaching any file there reaches
    // it too. Test files are excluded as the trigger: production code and spawned binaries don't load tests.
    const node = graph.node(id);
    if (minConfidence === Confidence.heuristic && policy.mode === 'conservative' && node?.kind === 'file' && !node.isTest) {
      for (const dependent of graph.wildcardDependents(node.packageId ?? NO_PACKAGE)) visit(dependent, id, distance);
    }
  }
  return reached;
}

const score = (distance: number, confidence: Confidence): number => ((confidence + 1) / 3) * DECAY ** distance;
