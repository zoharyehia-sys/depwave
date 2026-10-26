/** Repo-relative POSIX path helpers. '' is the repository root. */

export const dirOf = (path: string): string => {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
};

export const joinPath = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`);

/** Resolves `relative` against `base` ('.', '..', empty segments). Undefined if the result escapes the repository. */
export function resolvePath(base: string, relative: string): string | undefined {
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

export const isRelativeSpecifier = (specifier: string): boolean =>
  specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');

/** `@scope/pkg/sub` → `@scope/pkg`, `lodash/fp` → `lodash`. */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? specifier);
}
