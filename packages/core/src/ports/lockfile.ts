import type { LockfileDiff } from '../model/changes.js';

export interface LockfileChange {
  /** Repo-relative lockfile path. */
  path: string;
  /** Content at the base revision; undefined when the lockfile was added. */
  before: string | undefined;
  /** Content at the head revision; undefined when the lockfile was deleted. */
  after: string | undefined;
  /**
   * Head-revision files that decide how node_modules is laid out (`.npmrc`, `pnpm-workspace.yaml`), by repo-relative
   * path. Hoisting makes a dependency visible to packages that never declared it.
   */
  layoutConfig: ReadonlyMap<string, string>;
}

export interface LockfilePort {
  /** Whether this adapter can narrow changes to `path` (others keep the run-everything default). */
  supports(path: string): boolean;
  /** Config files `diff` wants in `layoutConfig`, for a lockfile at `path`. */
  layoutConfigPaths(path: string): string[];
  diff(change: LockfileChange): LockfileDiff;
}
