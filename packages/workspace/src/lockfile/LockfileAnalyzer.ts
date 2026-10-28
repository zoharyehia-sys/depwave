import { baseNameOf, dirOf, type LockfileChange, type LockfileDiff, type LockfilePort } from '@depwave/core';
import { diffLockGraphs, readLayout, Unsupported, type LockGraph } from './LockGraph.js';
import { parseNpmLockfile } from './NpmLockfile.js';
import { parsePnpmLockfile } from './PnpmLockfile.js';
import { parseYarnLockfile } from './YarnLockfile.js';

interface Format {
  parse(text: string, path: string, side: string): LockGraph;
  /** Config files (next to the lockfile and at the root) that decide hoisting. */
  layoutFiles: readonly string[];
  /** Whether the package manager hoists everything by default (npm, yarn's node-modules linker). */
  hoistsAll: boolean;
}

const FORMATS: Record<string, Format> = {
  'pnpm-lock.yaml': { parse: parsePnpmLockfile, layoutFiles: ['.npmrc', 'pnpm-workspace.yaml'], hoistsAll: false },
  'package-lock.json': { parse: parseNpmLockfile, layoutFiles: [], hoistsAll: true },
  'npm-shrinkwrap.json': { parse: parseNpmLockfile, layoutFiles: [], hoistsAll: true },
  // Berry's default linker is Plug'n'Play, which is strict; `.yarnrc.yml` can switch to node-modules (hoisted).
  'yarn.lock': { parse: parseYarnLockfile, layoutFiles: ['.yarnrc.yml'], hoistsAll: false },
};

/**
 * Narrows a lockfile change to the workspace importers whose resolved dependency closure changed (pnpm, npm, yarn
 * berry). Everything it can't attribute to importers falls back to `all`, with the reason.
 */
export class LockfileAnalyzer implements LockfilePort {
  supports(path: string): boolean {
    return baseNameOf(path) in FORMATS;
  }

  layoutConfigPaths(path: string): string[] {
    const dir = dirOf(path);
    const files = FORMATS[baseNameOf(path)]?.layoutFiles ?? [];
    return [...new Set(files.flatMap((name) => [name, dir === '' ? name : `${dir}/${name}`]))];
  }

  diff({ path, before, after, layoutConfig }: LockfileChange): LockfileDiff {
    const format = FORMATS[baseNameOf(path)];
    if (!format) return { kind: 'all', reason: `${baseNameOf(path)} is not analyzed` };
    if (before === undefined) return { kind: 'all', reason: `${path} was added` };
    if (after === undefined) return { kind: 'all', reason: `${path} was deleted` };
    try {
      return diffLockGraphs(path, format.parse(before, path, 'base'), format.parse(after, path, 'head'), readLayout(layoutConfig, format.hoistsAll));
    } catch (error) {
      if (error instanceof Unsupported) return { kind: 'all', reason: error.message };
      throw error;
    }
  }
}
