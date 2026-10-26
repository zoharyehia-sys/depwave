import type { GlobalTrigger } from './changes.js';
import type { Confidence, EdgeKind } from './graph.js';
import type { NodeId } from './ids.js';

export type ImpactMode = 'conservative' | 'balanced' | 'aggressive';

export interface ImpactPolicyOptions {
  mode: ImpactMode;
  /** Undefined = unbounded. */
  maxDepth?: number;
  /** Follow `import type` edges (type-check impact) or not (runtime impact). */
  includeTypeOnly: boolean;
  followEdges: readonly EdgeKind[];
}

export interface ImpactedNode {
  id: NodeId;
  /** Hops from the nearest seed. */
  distance: number;
  /** Weakest-link confidence along the best path. */
  confidence: Confidence;
  /** Next node on the shortest path back to a seed (for `depwave why`); undefined for seeds. */
  via?: NodeId;
  score: number;
}

export interface UnresolvedImport {
  from: string;
  specifier: string;
  reason: string;
}

export interface ImpactReport {
  /** The merge base actually compared against (not the ref the user passed). */
  base: string;
  head: string;
  /** Changed paths as git reported them (both sides of renames). */
  changedFiles: string[];
  seeds: NodeId[];
  globalTriggers: GlobalTrigger[];
  impacted: ImpactedNode[];
  /** Head-revision imports that resolved to nothing. Surfaced so silent gaps can't hide. */
  unresolved: UnresolvedImport[];
}

export interface TestPlanGroup {
  packageName: string;
  runner: 'vitest' | 'jest' | 'pytest' | 'unknown';
  /** Test files ordered by descending score (fail fast). */
  tests: string[];
}

export interface TestPlan {
  /** True when a global trigger forced a full run. */
  runAll: boolean;
  groups: TestPlanGroup[];
}
