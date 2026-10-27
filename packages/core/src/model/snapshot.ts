import type { GraphEdge, GraphNode } from './graph.js';
import type { NodeId } from './ids.js';
import type { UnresolvedImport } from './impact.js';
import type { Workspace } from './workspace.js';

export const SNAPSHOT_FORMAT = 1;

/**
 * Everything the pipeline derives from one commit, serializable. Commits are immutable, so a snapshot keyed by
 * (commit, configHash) never needs invalidation: a hit skips inventory, parsing, resolution and linking entirely.
 */
export interface GraphSnapshot {
  formatVersion: typeof SNAPSHOT_FORMAT;
  commit: string;
  /** Parser + resolver + depwave config versions the snapshot was built with. */
  configHash: string;
  workspace: Workspace;
  nodes: GraphNode[];
  edges: GraphEdge[];
  wildcards: Array<[scope: NodeId, dependents: NodeId[]]>;
  unresolved: UnresolvedImport[];
}
