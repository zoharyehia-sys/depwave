import type { GraphView } from '../graph/DependencyGraph.js';
import type { GlobalTrigger } from '../model/changes.js';
import { Confidence, MODULE_SYMBOL, type EdgeKind, type GraphNode } from '../model/graph.js';
import { nodeId, parseNodeId, type NodeId } from '../model/ids.js';
import type { ImpactReport } from '../model/impact.js';
import { dirOf, isWithin } from '../paths.js';
import { explainPath } from './ImpactPredictor.js';

/** How one node depends on the next one along the path. `WILDCARD`: reached through an `import(expr)` widening. */
export type StepRelation = EdgeKind | 'WILDCARD';

export interface ExplanationStep {
  id: NodeId;
  /** Repo-relative file the node lives in. */
  path: string;
  /** Symbol name, `<module>`, or undefined for a whole file. */
  symbol?: string;
  /** 1-based start line for symbols. */
  line?: number;
  /** Relation from the PREVIOUS step to this one (absent on the first step: the target itself). */
  relation?: StepRelation;
  confidence?: Confidence;
  typeOnly?: boolean;
}

/** Why the last step of the path counted as changed. */
export type SeedCause =
  | { kind: 'changed' } // the file is in the diff
  | { kind: 'trigger'; triggers: GlobalTrigger[] }; // seeded by a config/manifest/lockfile change

export type Explanation =
  | { kind: 'impacted'; target: string; steps: ExplanationStep[]; cause: SeedCause; heuristic: boolean }
  | { kind: 'not-impacted'; target: string; changedFiles: string[] }
  | { kind: 'unknown'; target: string };

/**
 * Explains why `targetPath` is (or isn't) impacted, along the shortest path with the confidence the walk reported.
 * Each step names the concrete relation (calls, re-exports, dynamic import…) looked up in the graph, and the path's
 * origin is classified as a direct change or a global trigger, so a config-driven selection is never dressed up as code.
 */
export function explainImpact(targetPath: string, report: ImpactReport, graph: GraphView): Explanation {
  const targetId = nodeId.file(targetPath);
  const target = report.impacted.find((n) => n.id === targetId);
  if (!target) {
    return graph.node(targetId) ? { kind: 'not-impacted', target: targetPath, changedFiles: report.changedFiles } : { kind: 'unknown', target: targetPath };
  }

  const ids = explainPath(graph, report.seeds, target);
  const steps: ExplanationStep[] = ids.map((id, i) => {
    const step = describe(id, graph.node(id));
    if (i === 0) return step;
    const relation = relationBetween(graph, ids[i - 1]!, id);
    return { ...step, ...relation };
  });
  const seed = steps.at(-1)!;
  const heuristic = steps.some((s) => s.confidence !== undefined && s.confidence < Confidence.certain);
  return { kind: 'impacted', target: targetPath, steps, cause: seedCause(seed.path, report, graph), heuristic };
}

function describe(id: NodeId, node: GraphNode | undefined): ExplanationStep {
  const parsed = parseNodeId(id);
  const step: ExplanationStep = { id, path: parsed.target };
  if (parsed.kind === 'symbol' && parsed.member !== undefined) {
    step.symbol = parsed.member;
    if (node?.kind === 'symbol' && parsed.member !== MODULE_SYMBOL) step.line = node.span.startLine;
  }
  return step;
}

/** The edge `dependent → dependency` the walk followed, or the wildcard widening when no edge exists. */
function relationBetween(graph: GraphView, dependent: NodeId, dependency: NodeId): Pick<ExplanationStep, 'relation' | 'confidence' | 'typeOnly'> {
  let best: { kind: EdgeKind; confidence: Confidence; typeOnly?: boolean } | undefined;
  for (const edge of graph.inEdges(dependency)) {
    if (edge.from !== dependent) continue;
    if (!best || edge.confidence > best.confidence) best = edge; // the most certain of parallel edges
  }
  if (!best) return { relation: 'WILDCARD', confidence: Confidence.heuristic };
  return { relation: best.kind, confidence: best.confidence, ...(best.typeOnly ? { typeOnly: true } : {}) };
}

/** A seed is either a changed file, or a file a global trigger pulled in (matched by repo-wide, package or directory scope). */
function seedCause(path: string, report: ImpactReport, graph: GraphView): SeedCause {
  if (report.changedFiles.includes(path)) return { kind: 'changed' };
  const file = graph.node(nodeId.file(path));
  const packageId = file?.kind === 'file' ? file.packageId : undefined;
  const covers = (t: GlobalTrigger): boolean => {
    if (t.scope === undefined) return true;
    if (t.kind === 'package-manifest' || t.kind === 'data-file' || t.kind === 'lockfile') return packageId !== undefined && t.scope.includes(packageId);
    return isWithin(path, dirOf(t.path)); // tsconfig / test config: everything under its directory
  };
  return { kind: 'trigger', triggers: report.globalTriggers.filter(covers) };
}
