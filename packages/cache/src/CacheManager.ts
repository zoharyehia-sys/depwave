import {
  NotImplementedError,
  type CachePort,
  type CacheStats,
  type FactsKey,
  type FileFacts,
  type GraphSnapshot,
  type ResolutionKey,
  type ResolutionResult,
} from '@depwave/core';

/** SQLite (better-sqlite3, WAL) at `.depwave/cache.db`. L1 facts land in Phase 1, L2/L3 in Phase 2. */
export class CacheManager implements CachePort {
  constructor(readonly dbPath: string) {}

  getFacts(_key: FactsKey): FileFacts | undefined {
    throw new NotImplementedError('CacheManager.getFacts', 'Phase 1');
  }

  putFacts(_facts: readonly FileFacts[]): void {
    throw new NotImplementedError('CacheManager.putFacts', 'Phase 1');
  }

  getResolution(_key: ResolutionKey): ResolutionResult | undefined {
    throw new NotImplementedError('CacheManager.getResolution', 'Phase 2');
  }

  putResolution(_key: ResolutionKey, _result: ResolutionResult): void {
    throw new NotImplementedError('CacheManager.putResolution', 'Phase 2');
  }

  invalidateResolutionsProbing(_paths: readonly string[]): string[] {
    throw new NotImplementedError('CacheManager.invalidateResolutionsProbing', 'Phase 2');
  }

  loadSnapshot(_commit: string, _configHash: string): GraphSnapshot | undefined {
    throw new NotImplementedError('CacheManager.loadSnapshot', 'Phase 2');
  }

  saveSnapshot(_snapshot: GraphSnapshot): void {
    throw new NotImplementedError('CacheManager.saveSnapshot', 'Phase 2');
  }

  stats(): CacheStats {
    throw new NotImplementedError('CacheManager.stats', 'Phase 1');
  }

  close(): void {}
}
