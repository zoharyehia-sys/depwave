import type { Inventory, Workspace } from '../model/workspace.js';
import type { Revision, TrackedFile } from './git.js';

export interface WorkspacePort {
  /**
   * Packages at a revision, read through git so any commit works without a checkout.
   * Pass `tracked` when the caller already listed the revision, to avoid a second listing.
   */
  discover(rev: Revision, tracked?: readonly TrackedFile[]): Promise<Workspace>;
}

export interface InventoryPort {
  /** Every source file at a revision with its language, content hash and owning package. */
  inventory(rev: Revision): Promise<Inventory>;
}
