import type { WorkspacePackage } from '@ripple/core';

/** POSIX helpers for repo-relative paths ('' is the repo root). */
export const dirOf = (path: string): string => {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
};

export const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export const joinPath = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`);

/** Returns a lookup from file path to its owning package: the deepest package root containing it. O(depth) per file. */
export function createOwnerLookup(packages: readonly WorkspacePackage[]): (path: string) => WorkspacePackage | undefined {
  const byRoot = new Map(packages.map((p) => [p.root, p]));
  return (path) => {
    for (let dir = dirOf(path); ; dir = dirOf(dir)) {
      const owner = byRoot.get(dir);
      if (owner) return owner;
      if (dir === '') return undefined;
    }
  };
}
