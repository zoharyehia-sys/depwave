import { joinPath, dirOf } from './paths.js';
import type { Lookup, VirtualFileSystem } from './vfs.js';

/**
 * Finds the nearest file with one of `names`, walking up from a directory. Results are cached per directory
 * together with the paths that were checked, and those probes are replayed into every Lookup that hits the cache,
 * so caching never makes a probe list incomplete.
 */
export class NearestFile {
  private readonly cache = new Map<string, { found: string | undefined; probed: string[] }>();

  constructor(
    private readonly fs: VirtualFileSystem,
    private readonly names: readonly string[],
  ) {}

  find(dir: string, lookup: Lookup): string | undefined {
    let hit = this.cache.get(dir);
    if (!hit) {
      hit = this.search(dir);
      this.cache.set(dir, hit);
    }
    lookup.recordAll(hit.probed);
    return hit.found;
  }

  private search(start: string): { found: string | undefined; probed: string[] } {
    const probed: string[] = [];
    for (let dir = start; ; dir = dirOf(dir)) {
      for (const name of this.names) {
        const path = joinPath(dir, name);
        probed.push(path);
        if (this.fs.isFile(path)) return { found: path, probed };
      }
      if (dir === '') return { found: undefined, probed };
    }
  }
}
