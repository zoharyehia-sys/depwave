import type { SourceFile, Workspace } from '../model/workspace.js';
import type { Revision } from './git.js';

export interface WorkspacePort {
  /** Detect the workspace tool and its packages (pnpm, npm/yarn workspaces, nx). */
  discover(rootDir: string): Promise<Workspace>;
  /** All analyzable source files at a revision, hashed (git OIDs where possible). */
  inventory(workspace: Workspace, rev: Revision): Promise<SourceFile[]>;
}
