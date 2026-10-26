import type { NodeId } from './ids.js';

/** `git diff --name-status` statuses we care about (copies are treated as adds). */
export type ChangeStatus = 'A' | 'M' | 'D' | 'R';

export interface FileChange {
  status: ChangeStatus;
  path: string;
  /** Previous path for renames. */
  oldPath?: string;
  oldOid?: string;
  newOid?: string;
}

/** A `git diff -U0` hunk. Line numbers are 1-based; a count of 0 means pure insertion/deletion. */
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export type GlobalTriggerKind = 'lockfile' | 'tsconfig' | 'package-manifest' | 'ci-config' | 'custom';

export interface GlobalTrigger {
  kind: GlobalTriggerKind;
  path: string;
  /** Packages to treat as fully impacted; undefined means the whole repo. */
  scope?: NodeId[];
}

export interface ChangeSet {
  /** Changed symbols/files on either side of the diff (old side catches deletions). */
  seeds: NodeId[];
  globalTriggers: GlobalTrigger[];
}
