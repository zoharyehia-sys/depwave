import type { GraphEdge, GraphNode } from './graph.js';

/** Serializable graph at one commit. Commits are immutable, so snapshots never need invalidation. */
export interface GraphSnapshot {
  formatVersion: 1;
  commit: string;
  /** Hash of the depwave config + parser versions the snapshot was built with. */
  configHash: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
