import type { FileChange, Hunk } from '../model/changes.js';

/** Pseudo-revision for uncommitted working-tree state. */
export const WORKTREE = 'WORKTREE';
export type Revision = string;

export interface TrackedFile {
  path: string;
  /** Git blob OID: a free content hash for every tracked file. */
  oid: string;
}

/** All paths are repo-root-relative POSIX paths, whatever directory the adapter was created in. */
export interface GitPort {
  /** WORKTREE is treated as HEAD. */
  mergeBase(a: Revision, b: Revision): Promise<string>;
  /** Changed files with rename detection. With `head` = WORKTREE, includes unstaged and untracked (non-ignored) files. */
  diff(base: Revision, head: Revision): Promise<FileChange[]>;
  /**
   * Zero-context hunks for one file. Pass `oldPath` for renames so hunks cover only the edits, not the whole file.
   * Untracked files yield no hunks: callers treat added files as wholly changed.
   */
  hunks(base: Revision, head: Revision, path: string, oldPath?: string): Promise<Hunk[]>;
  /** Blob oids at a revision. For WORKTREE, dirty and untracked files are hashed so oids match their current content. */
  listTracked(rev: Revision): Promise<TrackedFile[]>;
  readBlob(rev: Revision, path: string): Promise<string>;
  /** Many files in one round trip (one process for commits). Missing paths are absent from the result. */
  readBlobs(rev: Revision, paths: readonly string[]): Promise<Map<string, string>>;
}
