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

/**
 * ci-config / custom (workspace config): everything. tsconfig: everything under its directory.
 * package-manifest: a package and its dependents. data-file: the tests of one package, which may read the file at runtime.
 * lockfile: the packages whose resolved dependencies changed, and their dependents (everything when that can't be told).
 */
export type GlobalTriggerKind = 'lockfile' | 'tsconfig' | 'package-manifest' | 'ci-config' | 'data-file' | 'custom';

export interface GlobalTrigger {
  kind: GlobalTriggerKind;
  path: string;
  /** Packages to treat as fully impacted; undefined means the whole repo. */
  scope?: NodeId[];
  /** One line for humans: what changed (`vitest 3.2.6 → 3.2.7`), or why the whole repo is in scope. */
  detail?: string;
}

/**
 * What a lockfile change means for the workspace, from an adapter that understands the format. `all` (an unknown
 * format, a settings change, a dependency every package can see) keeps the sound default: every test runs.
 */
export type LockfileDiff =
  | {
      kind: 'importers';
      /** Repo-relative directories of the importers (workspace packages) whose resolved dependencies changed; '' = root. */
      importers: string[];
      /** What changed, for reports: `vitest 3.2.6 → 3.2.7`, `+ left-pad 1.3.0`, `- request 2.88.2`. */
      changes: string[];
    }
  | { kind: 'all'; reason: string };

export interface ChangeSet {
  /** Changed symbols/files on either side of the diff (old side catches deletions). */
  seeds: NodeId[];
  globalTriggers: GlobalTrigger[];
}
