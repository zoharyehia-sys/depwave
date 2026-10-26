import { join } from 'node:path';
import { CacheManager } from '@ripple/cache';
import {
  NotImplementedError,
  type CachePort,
  type GitPort,
  type ImpactReport,
  type ParserPort,
  type Revision,
  type TestPlan,
  type WorkspacePort,
} from '@ripple/core';
import { GitService } from '@ripple/git';
import { ASTParser, LanguageRegistry } from '@ripple/parser';
import { WorkspaceDiscovery } from '@ripple/workspace';

export interface PipelineDeps {
  git: GitPort;
  workspace: WorkspacePort;
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
  return new AnalysisPipeline({
    git: new GitService(cwd),
    workspace: new WorkspaceDiscovery(),
    parser: new ASTParser(new LanguageRegistry()),
    cache: new CacheManager(join(cwd, '.ripple', 'cache.db')),
  });
}
