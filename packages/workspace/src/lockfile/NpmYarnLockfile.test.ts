import { describe, expect, it } from 'vitest';
import { LockfileAnalyzer } from './LockfileAnalyzer.js';
import { resolveFrom } from './NpmLockfile.js';

const analyzer = new LockfileAnalyzer();
const diff = (path: string, before: string | undefined, after: string | undefined, layoutConfig: Record<string, string> = {}) =>
  analyzer.diff({ path, before, after, layoutConfig: new Map(Object.entries(layoutConfig)) });

/**
 * npm workspaces: `a` uses ms (hoisted); `b` uses debug, which needs an OLD ms, so npm nests it under debug;
 * `c` pins its own left-pad, nested under the workspace. `@x/a` is linked into node_modules.
 */
const npmLock = (overrides: Record<string, unknown> = {}) =>
  `${JSON.stringify(
    {
      name: 'root',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'root', workspaces: ['packages/*'], devDependencies: { typescript: '^5.4.0' } },
        'node_modules/@x/a': { resolved: 'packages/a', link: true },
        'node_modules/debug': { version: '4.3.4', integrity: 'sha512-debug', dependencies: { ms: '2.0.0' } },
        'node_modules/debug/node_modules/ms': { version: '2.0.0', integrity: 'sha512-ms-old' },
        'node_modules/left-pad': { version: '1.3.0', integrity: 'sha512-left-pad-1.3' },
        'node_modules/ms': { version: '2.1.2', integrity: 'sha512-ms' },
        'node_modules/typescript': { version: '5.4.5', integrity: 'sha512-ts', dev: true },
        'packages/a': { name: '@x/a', version: '1.0.0', dependencies: { ms: '^2.1.2' } },
        'packages/b': { name: '@x/b', version: '1.0.0', dependencies: { '@x/a': '*', debug: '^4.3.4' } },
        'packages/c': { name: '@x/c', version: '1.0.0', dependencies: { 'left-pad': '1.2.0' } },
        'packages/c/node_modules/left-pad': { version: '1.2.0', integrity: 'sha512-left-pad-1.2' },
        ...overrides,
      },
    },
    null,
    2,
  )}\n`;

describe('npm package-lock.json', () => {
  it('resolves dependencies the way Node does: nearest node_modules first, walking up', () => {
    const packages = JSON.parse(npmLock()).packages as Record<string, unknown>;
    expect(resolveFrom('packages/a', 'ms', packages)).toBe('node_modules/ms');
    expect(resolveFrom('node_modules/debug', 'ms', packages)).toBe('node_modules/debug/node_modules/ms');
    expect(resolveFrom('packages/c', 'left-pad', packages)).toBe('packages/c/node_modules/left-pad');
    expect(resolveFrom('node_modules/@x/a', 'ms', packages)).toBe('node_modules/ms'); // a scoped folder is one level
    expect(resolveFrom('packages/a', 'missing', packages)).toBeUndefined();
  });

  it('selects the workspace whose resolution reaches the change, with every dependent package name for hoisting', () => {
    const after = npmLock({ 'node_modules/debug/node_modules/ms': { version: '2.0.1', integrity: 'sha512-ms-old-2' } });
    // Only b reaches the nested ms (a gets the hoisted one). But hoisting lets any code import `ms` or `debug`.
    expect(diff('package-lock.json', npmLock(), after)).toEqual({ kind: 'importers', importers: ['packages/b'], changes: ['ms 2.0.0 → 2.0.1'], hoisted: ['debug', 'ms'] });
  });

  it('a nested copy inside a workspace affects that workspace only', () => {
    const after = npmLock({ 'packages/c/node_modules/left-pad': { version: '1.2.0', integrity: 'sha512-left-pad-1.2-republished' } });
    expect(diff('package-lock.json', npmLock(), after)).toMatchObject({ importers: ['packages/c'], hoisted: ['left-pad'] });
  });

  it('a root devDependency change reaches the root importer (which selects everything later)', () => {
    const after = npmLock({ 'node_modules/typescript': { version: '5.5.4', integrity: 'sha512-ts-2', dev: true } });
    expect(diff('package-lock.json', npmLock(), after)).toMatchObject({ importers: [''], changes: ['typescript 5.4.5 → 5.5.4'] });
  });

  it('ignores workspace links and the v1-compatible `dependencies` mirror', () => {
    const data = JSON.parse(npmLock());
    data.dependencies = { ms: { version: '2.1.2' } };
    const mirrored = `${JSON.stringify(data, null, 2)}\n`;
    data.dependencies = { ms: { version: '9.9.9' } };
    expect(diff('package-lock.json', mirrored, `${JSON.stringify(data, null, 2)}\n`)).toEqual({ kind: 'importers', importers: [], changes: [], hoisted: [] });
  });

  it.each([
    ['lockfileVersion 1', npmLock().replace('"lockfileVersion": 3', '"lockfileVersion": 1'), /npm lockfileVersion 1 is not analyzed/],
    ['invalid JSON', '{ "packages": ', /could not parse package-lock\.json at head/],
    ['a top-level change', npmLock().replace('"requires": true', '"requires": false'), /`requires` section changed/],
  ])('selects everything for %s', (_, after, reason) => {
    expect(diff('package-lock.json', npmLock(), after)).toEqual({ kind: 'all', reason: expect.stringMatching(reason) });
  });

  it('applies to npm-shrinkwrap.json too, and treats eslint/prettier packages as visible everywhere', () => {
    const after = npmLock({ 'node_modules/eslint-plugin-x': { version: '1.0.0', integrity: 'sha512-e' } });
    expect(diff('npm-shrinkwrap.json', npmLock(), after)).toEqual({ kind: 'all', reason: expect.stringMatching(/^eslint-plugin-x changed, and it is hoisted/) });
  });
});

/** Yarn berry: `a` uses ms; `b` uses debug (→ ms) and the workspace `a`. */
const yarnLock = (ms = '2.1.2', metadata = 'version: 8\n  cacheKey: 10c0') => `# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  ${metadata}

"@x/a@workspace:*, @x/a@workspace:packages/a":
  version: 0.0.0-use.local
  resolution: "@x/a@workspace:packages/a"
  dependencies:
    ms: "npm:^2.1.2"
  languageName: unknown
  linkType: soft

"@x/b@workspace:packages/b":
  version: 0.0.0-use.local
  resolution: "@x/b@workspace:packages/b"
  dependencies:
    "@x/a": "workspace:*"
    debug: "npm:^4.3.4"
  languageName: unknown
  linkType: soft

"@x/c@workspace:packages/c":
  version: 0.0.0-use.local
  resolution: "@x/c@workspace:packages/c"
  languageName: unknown
  linkType: soft

"debug@npm:^4.3.4":
  version: 4.3.4
  resolution: "debug@npm:4.3.4"
  dependencies:
    ms: "npm:2.1.2"
  checksum: 10c0/debug
  languageName: node
  linkType: hard

"ms@npm:2.1.2, ms@npm:^2.1.2":
  version: ${ms}
  resolution: "ms@npm:${ms}"
  checksum: 10c0/ms-${ms}
  languageName: node
  linkType: hard

"root@workspace:.":
  version: 0.0.0-use.local
  resolution: "root@workspace:."
  languageName: unknown
  linkType: soft
`;

describe('yarn berry yarn.lock', () => {
  it("Plug'n'Play (the default) is strict: only importers that declare their way to the change", () => {
    expect(diff('yarn.lock', yarnLock(), yarnLock('2.1.3'))).toEqual({ kind: 'importers', importers: ['packages/a', 'packages/b'], changes: ['ms 2.1.2 → 2.1.3'] });
  });

  it.each([
    ['nodeLinker: node-modules', 'nodeLinker: node-modules\n'],
    ['pnpMode: loose', 'pnpMode: loose\n'],
  ])('%s hoists: the changed names (and their dependents) are reported for import-based widening', (_, yarnrc) => {
    expect(diff('yarn.lock', yarnLock(), yarnLock('2.1.3'), { '.yarnrc.yml': yarnrc })).toMatchObject({ importers: ['packages/a', 'packages/b'], hoisted: ['debug', 'ms'] });
  });

  it('reads yarn 2/3 lockfiles, whose dependency ranges have no `npm:` prefix', () => {
    const yarn3 = (ms: string) =>
      yarnLock(ms, 'version: 6\n  cacheKey: 8').replace('ms: "npm:^2.1.2"', 'ms: ^2.1.2').replace('debug: "npm:^4.3.4"', 'debug: ^4.3.4').replace('ms: "npm:2.1.2"', 'ms: 2.1.2');
    expect(yarn3('2.1.2')).not.toContain('"npm:');
    expect(diff('yarn.lock', yarn3('2.1.2'), yarn3('2.1.3'))).toEqual({ kind: 'importers', importers: ['packages/a', 'packages/b'], changes: ['ms 2.1.2 → 2.1.3'] });
  });

  it('a checksum-only change still counts', () => {
    expect(diff('yarn.lock', yarnLock(), yarnLock().replace('checksum: 10c0/debug', 'checksum: 10c0/debug-2'))).toMatchObject({ importers: ['packages/b'] });
  });

  it.each([
    ['yarn classic (v1)', '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\nms@^2.1.2:\n  version "2.1.3"\n', /yarn classic \(v1\)/],
    ['no __metadata', 'ms@npm:^2.1.2:\n  version: 2.1.3\n', /not a yarn berry lockfile/],
    ['a cache key change', yarnLock('2.1.2', 'version: 8\n  cacheKey: 10c1'), /`__metadata` section changed/],
    ['a format change', yarnLock('2.1.2', 'version: 9\n  cacheKey: 10c0'), /lockfile format changed \(v8 → v9\)/],
  ])('selects everything for %s', (_, after, reason) => {
    expect(diff('yarn.lock', yarnLock(), after)).toEqual({ kind: 'all', reason: expect.stringMatching(reason) });
  });
});
