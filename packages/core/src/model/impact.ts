import type { GlobalTrigger } from './changes.js';
import type { Confidence, EdgeKind, Granularity } from './graph.js';
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
  /** Hops back to a seed along the shortest path that gives `confidence`. */
  distance: number;
  /** Best weakest-link confidence over every path from a seed. */
  confidence: Confidence;
  /** Next node back to a seed on that path; undefined for seeds. `explainPath` gives the whole path. */
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
  granularity: Granularity;
  /** Changed paths as git reported them (both sides of renames). */
  changedFiles: string[];
  seeds: NodeId[];
  globalTriggers: GlobalTrigger[];
  impacted: ImpactedNode[];
  /** Head-revision imports that resolved to nothing. Surfaced so silent gaps can't hide. */
  unresolved: UnresolvedImport[];
  /** Non-fatal problems found while analyzing (e.g. duplicate workspace package names). */
  warnings?: string[];
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
  /** Every test file in the head revision, impacted or not: the denominator for "3 of 41". */
  totalTests?: number;
}
