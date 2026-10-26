import type { FileFacts } from '../model/facts.js';
import type { LanguageId } from '../model/graph.js';
import type { GraphSnapshot } from '../model/snapshot.js';
import type { ResolutionResult } from './resolver.js';

export interface FactsKey {
  contentHash: string;
  language: LanguageId;
  parserVersion: string;
}

export interface ResolutionKey {
  fromDir: string;
  specifier: string;
  configHash: string;
}

export interface CacheStats {
  facts: number;
  resolutions: number;
  snapshots: number;
  bytes: number;
}

/**
 * Three layers, three invalidation rules (ARCHITECTURE.md §4.1):
 *  L1 facts       content-addressed, immutable, LRU-collected
 *  L2 resolutions invalidated by config hash or by add/delete at a probed path
 *  L3 snapshots   keyed by commit, immutable
 */
export interface CachePort {
  getFacts(key: FactsKey): FileFacts | undefined;
  putFacts(facts: readonly FileFacts[]): void;

  getResolution(key: ResolutionKey): ResolutionResult | undefined;
  putResolution(key: ResolutionKey, result: ResolutionResult): void;
  /** Drops resolutions whose probe set includes any of `paths`; returns the affected importer dirs. */
  invalidateResolutionsProbing(paths: readonly string[]): string[];

  loadSnapshot(commit: string, configHash: string): GraphSnapshot | undefined;
  saveSnapshot(snapshot: GraphSnapshot): void;

  stats(): CacheStats;
  close(): void;
}
