import type { GitPort, Revision, TrackedFile } from '@depwave/core';
import { parseJsonc } from './jsonc.js';
import { dirOf } from './paths.js';

const CONFIG_FILE = /(^|\/)(package\.json|[tj]sconfig[^/]*\.json)$/;

/**
 * The repository as it exists at one revision: the set of tracked paths plus the contents of every config file
 * resolution can read (package.json, tsconfig*.json, jsconfig*.json). Built from git, so any commit can be resolved
 * without a checkout, and lookups are synchronous and side-effect free.
 */
export class VirtualFileSystem {
  private readonly files: ReadonlySet<string>;
  private readonly dirs = new Set<string>(['']);
  private readonly jsonCache = new Map<string, unknown>();

  constructor(
    paths: Iterable<string>,
    private readonly contents: ReadonlyMap<string, string> = new Map(),
  ) {
    this.files = new Set(paths);
    for (const file of this.files) {
      for (let dir = dirOf(file); !this.dirs.has(dir); dir = dirOf(dir)) this.dirs.add(dir);
    }
  }

  static isConfigFile(path: string): boolean {
    return CONFIG_FILE.test(path);
  }

  /** One listing (reused if given) plus one batched read of every config file. */
  static async fromGit(git: GitPort, rev: Revision, tracked?: readonly TrackedFile[]): Promise<VirtualFileSystem> {
    const paths = (tracked ?? (await git.listTracked(rev))).map((f) => f.path);
    const contents = await git.readBlobs(rev, paths.filter((p) => VirtualFileSystem.isConfigFile(p)));
    return new VirtualFileSystem(paths, contents);
  }

  isFile(path: string): boolean {
    return this.files.has(path);
  }

  isDirectory(path: string): boolean {
    return this.dirs.has(path);
  }

  /** Parsed JSON/JSONC of a config file; undefined if absent, not preloaded, or malformed. */
  readJson(path: string): Record<string, unknown> | undefined {
    if (!this.jsonCache.has(path)) {
      const text = this.contents.get(path);
      let value: unknown;
      try {
        value = text === undefined ? undefined : parseJsonc(text);
      } catch {
        value = undefined; // malformed config: WorkspaceDiscovery reports it; resolution degrades to "no config"
      }
      this.jsonCache.set(path, isObject(value) ? value : undefined);
    }
    return this.jsonCache.get(path) as Record<string, unknown> | undefined;
  }
}

/**
 * Records every existence check made while resolving one specifier, in order, deduplicated.
 * A path that was checked and missing is exactly what must invalidate a cached resolution when it appears.
 */
export class Lookup {
  readonly probed: string[] = [];
  private readonly seen = new Set<string>();

  constructor(readonly fs: VirtualFileSystem) {}

  isFile(path: string): boolean {
    this.record(path);
    return this.fs.isFile(path);
  }

  record(path: string): void {
    if (this.seen.has(path)) return;
    this.seen.add(path);
    this.probed.push(path);
  }

  recordAll(paths: readonly string[]): void {
    for (const path of paths) this.record(path);
  }
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
