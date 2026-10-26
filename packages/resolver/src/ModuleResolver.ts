import { NotImplementedError, type ResolutionResult, type ResolverPort, type Workspace } from '@ripple/core';

/**
 * Wraps oxc-resolver (tsconfig paths, `exports` conditions, extension aliasing) and records probed paths.
 * Workspace packages resolve through the workspace manifest, not node_modules, so analysis works pre-install.
 */
export class ModuleResolver implements ResolverPort {
  constructor(readonly workspace: Workspace) {}

  configHash(_fromFile: string): string {
    throw new NotImplementedError('ModuleResolver.configHash', 'Phase 1');
  }

  resolve(_fromFile: string, _specifier: string): ResolutionResult {
    throw new NotImplementedError('ModuleResolver.resolve', 'Phase 1');
  }
}
