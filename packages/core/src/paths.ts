/** Repo-relative POSIX path helpers ('' is the repository root). Pure string logic, safe for core. */

export const dirOf = (path: string): string => {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
};

export const baseNameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** True if `path` is `dir` itself or inside it. '' contains everything. */
export const isWithin = (path: string, dir: string): boolean => dir === '' || path === dir || path.startsWith(`${dir}/`);

/** Resolves `relative` against `base`. Undefined if it escapes the repository. Glob characters pass through untouched. */
export function resolveRelative(base: string, relative: string): string | undefined {
  const segments = base === '' ? [] : base.split('/');
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return undefined;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join('/');
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** Default test-file convention: `*.test.*`, `*.spec.*`, or anything under `__tests__/`. */
export const isTestPath = (path: string): boolean => TEST_FILE.test(path) || path.split('/').includes('__tests__');
