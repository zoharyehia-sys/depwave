import { join } from 'node:path';
import { CacheManager } from '@ripple/cache';
import {
  NotImplementedError,
  type CachePort,
  type GitPort,
  type ImpactReport,
  type InventoryPort,
  type ParserPort,
  type Revision,
  type TestPlan,
} from '@ripple/core';
import { GitService } from '@ripple/git';
import { ASTParser } from '@ripple/parser';
import { SourceInventory, WorkspaceDiscovery } from '@ripple/workspace';

export interface PipelineDeps {
  git: GitPort;
  inventory: InventoryPort;
  parser: ParserPort;
  cache: CachePort;
}

export interface ImpactRequest {
  base: Revision;
  head: Revision;
}

export interface ImpactResult {
  report: ImpactReport;
  plan: TestPlan;
}

/**
 * Orchestrates one analysis run (ARCHITECTURE.md §3.5). Takes ports, not adapters, so tests can inject fakes.
 * The resolver is built per run because it needs the discovered workspace.
 */
export class AnalysisPipeline {
  constructor(readonly deps: PipelineDeps) {}

  async impact(_request: ImpactRequest): Promise<ImpactResult> {
    throw new NotImplementedError('ripple impact', 'Phase 1');
  }
}

/** Composition root: the only place adapters are instantiated. */
export function createPipeline(cwd: string): AnalysisPipeline {
  const git = new GitService(cwd);
  return new AnalysisPipeline({
    git,
    inventory: new SourceInventory(git, new WorkspaceDiscovery(git)),
    parser: new ASTParser(),
    cache: new CacheManager(join(cwd, '.ripple', 'cache.db')),
  });
}
