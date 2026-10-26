import type { FileChange, Hunk } from '../model/changes.js';

/** Pseudo-revision for uncommitted working-tree state. */
export const WORKTREE = 'WORKTREE';
export type Revision = string;

export interface TrackedFile {
  path: string;
  /** Git blob OID: a free content hash for every tracked file. */
  oid: string;
}

export interface GitPort {
  mergeBase(a: Revision, b: Revision): Promise<string>;
  /** Name-status diff with rename detection. `head` may be WORKTREE. */
  diff(base: Revision, head: Revision): Promise<FileChange[]>;
  /** Zero-context hunks for one file. */
  hunks(base: Revision, head: Revision, path: string): Promise<Hunk[]>;
  listTracked(rev: Revision): Promise<TrackedFile[]>;
  readBlob(rev: Revision, path: string): Promise<string>;
}
