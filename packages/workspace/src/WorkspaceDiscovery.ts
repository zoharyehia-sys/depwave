import { NotImplementedError, type Revision, type SourceFile, type Workspace, type WorkspacePort } from '@ripple/core';

/** Detects pnpm / npm / yarn workspaces (nx later) and inventories source files with their hashes. */
export class WorkspaceDiscovery implements WorkspacePort {
  async discover(_rootDir: string): Promise<Workspace> {
    throw new NotImplementedError('WorkspaceDiscovery.discover', 'Phase 1');
  }

  async inventory(_workspace: Workspace, _rev: Revision): Promise<SourceFile[]> {
    throw new NotImplementedError('WorkspaceDiscovery.inventory', 'Phase 1');
  }
}
