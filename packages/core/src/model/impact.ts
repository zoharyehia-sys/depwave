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
  /** Next node on the shortest path back to a seed (for `ripple why`); undefined for seeds. */
  via?: NodeId;
  score: number;
}

export interface ImpactReport {
  base: string;
  head: string;
  seeds: NodeId[];
  impacted: ImpactedNode[];
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
