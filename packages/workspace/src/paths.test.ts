import type { WorkspacePackage } from '@depwave/core';
import { describe, expect, it } from 'vitest';
import { createOwnerLookup } from './paths.js';
import { createMatcher } from './WorkspaceDiscovery.js';

const pkg = (name: string, root: string): WorkspacePackage => ({ name, root, manifestPath: `${root}/package.json`, dependencies: [] });

describe('createOwnerLookup', () => {
  const ownerOf = createOwnerLookup([pkg('root', ''), pkg('a', 'packages/a'), pkg('b', 'packages/a/plugins/b')]);

  it.each([
    ['packages/a/src/x.ts', 'a'],
    ['packages/a/plugins/b/src/y.ts', 'b'], // deepest root wins
    ['packages/a/plugins/other/z.ts', 'a'],
    ['packages/ab/src/x.ts', 'root'], // prefix of a name is not containment
    ['scripts/build.ts', 'root'],
    ['top.ts', 'root'],
  ])('%s → %s', (path, owner) => {
    expect(ownerOf(path)?.name).toBe(owner);
  });

  it('returns undefined outside every package when there is no root package', () => {
    expect(createOwnerLookup([pkg('a', 'packages/a')])('scripts/x.ts')).toBeUndefined();
  });
});

describe('createMatcher', () => {
  it('matches single-level, recursive and negated globs', () => {
    const match = createMatcher(['packages/*', 'apps/**', '!packages/internal', './tools/*/']);
    expect(match('packages/ui')).toBe(true);
    expect(match('packages/ui/nested')).toBe(false);
    expect(match('apps/web')).toBe(true);
    expect(match('apps/web/admin')).toBe(true);
    expect(match('packages/internal')).toBe(false);
    expect(match('tools/codegen')).toBe(true);
    expect(match('other/x')).toBe(false);
  });

  it('matches nothing without include patterns', () => {
    expect(createMatcher([])('packages/a')).toBe(false);
    expect(createMatcher(['!packages/a'])('packages/b')).toBe(false);
  });
});
