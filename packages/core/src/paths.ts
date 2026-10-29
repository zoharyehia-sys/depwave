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

/**
 * Drops a leading UTF-8 byte-order mark. Editors on Windows add one; Node, npm and pnpm all ignore it, but
 * `JSON.parse` rejects it, so every JSON file read from a repository goes through this first.
 */
export const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const JS_OR_TS = /\.[cm]?[jt]sx?$/;

/** Default test-file convention (Jest's): `*.test.*` / `*.spec.*`, or any JS/TS file under `__tests__/` (not its JSON or snapshots). */
export const isTestPath = (path: string): boolean => TEST_FILE.test(path) || (JS_OR_TS.test(path) && path.split('/').includes('__tests__'));
