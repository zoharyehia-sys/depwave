import type { GitPort, Revision } from '@depwave/core';
import picomatch from 'picomatch';
import { WorkspaceError } from './WorkspaceDiscovery.js';

export const CONFIG_FILE = 'depwave.config.json';

export interface DepwaveConfig {
  /** Globs (repo-relative) for paths that are not part of the analyzed code: fixtures, examples, vendored copies. */
  ignore: string[];
}

const DEFAULT_CONFIG: DepwaveConfig = { ignore: [] };

/** Reads `depwave.config.json` at the repository root as of `rev`. Absent → defaults. Invalid → WorkspaceError. */
export async function loadConfig(git: GitPort, rev: Revision, trackedPaths: ReadonlySet<string>): Promise<DepwaveConfig> {
  if (!trackedPaths.has(CONFIG_FILE)) return DEFAULT_CONFIG;
  const text = (await git.readBlobs(rev, [CONFIG_FILE])).get(CONFIG_FILE);
  if (text === undefined) return DEFAULT_CONFIG;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new WorkspaceError(CONFIG_FILE, `invalid JSON (${(error as Error).message})`);
  }
  const ignore = (raw as { ignore?: unknown } | null)?.ignore ?? [];
  if (!Array.isArray(ignore) || !ignore.every((g) => typeof g === 'string')) {
    throw new WorkspaceError(CONFIG_FILE, '`ignore` must be a list of glob strings');
  }
  return { ignore };
}

export function createIgnoreMatcher(config: DepwaveConfig): (path: string) => boolean {
  if (config.ignore.length === 0) return () => false;
  return picomatch(config.ignore, { dot: true });
}
