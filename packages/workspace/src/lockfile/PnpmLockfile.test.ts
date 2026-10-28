import { describe, expect, it } from 'vitest';
import { depPath, PnpmLockfileAnalyzer } from './PnpmLockfile.js';

const analyzer = new PnpmLockfileAnalyzer();

/** A v9 lockfile: `a` uses ms directly, `b` gets it through debug, `c` uses left-pad. */
const V9 = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      typescript:
        specifier: ^5.4.0
        version: 5.4.5

  packages/a:
    dependencies:
      ms:
        specifier: ^2.1.2
        version: 2.1.2

  packages/b:
    dependencies:
      '@x/a':
        specifier: workspace:*
        version: link:../a
      debug:
        specifier: ^4.3.4
        version: 4.3.4(supports-color@9.4.0)

  packages/c:
    dependencies:
      left-pad:
        specifier: ^1.3.0
        version: 1.3.0

packages:

  debug@4.3.4:
    resolution: {integrity: sha512-debug}

  left-pad@1.3.0:
    resolution: {integrity: sha512-left-pad}

  ms@2.1.2:
    resolution: {integrity: sha512-ms-2.1.2}

  supports-color@9.4.0:
    resolution: {integrity: sha512-supports-color}

  typescript@5.4.5:
    resolution: {integrity: sha512-ts}

snapshots:

  debug@4.3.4(supports-color@9.4.0):
    dependencies:
      ms: 2.1.2
    optionalDependencies:
      supports-color: 9.4.0

  left-pad@1.3.0: {}

  ms@2.1.2: {}

  supports-color@9.4.0: {}

  typescript@5.4.5: {}
`;

const diff = (before: string | undefined, after: string | undefined, layoutConfig: Record<string, string> = {}, path = 'pnpm-lock.yaml') =>
  analyzer.diff({ path, before, after, layoutConfig: new Map(Object.entries(layoutConfig)) });

/** Applies exact, unique replacements (the same rule as fixture scenarios). */
function edit(text: string, ...pairs: Array<[string, string]>): string {
  for (const [find, replace] of pairs) {
    const count = text.split(find).length - 1;
    if (count !== 1) throw new Error(`"${find}" occurs ${count} times`);
    text = text.replace(find, () => replace);
  }
  return text;
}

describe('PnpmLockfileAnalyzer', () => {
  it('maps a bump deep in the tree to every importer that reaches it, with a summary', () => {
    const after = edit(V9, ['ms@2.1.2:\n    resolution: {integrity: sha512-ms-2.1.2}', 'ms@2.1.3:\n    resolution: {integrity: sha512-ms-2.1.3}'], ['      ms: 2.1.2', '      ms: 2.1.3'], ['  ms@2.1.2: {}', '  ms@2.1.3: {}'], ['        version: 2.1.2', '        version: 2.1.3']);
    expect(diff(V9, after)).toEqual({ kind: 'importers', importers: ['packages/a', 'packages/b'], changes: ['ms 2.1.2 → 2.1.3'] });
  });

  it('follows optional dependencies and peer-suffixed keys', () => {
    const after = edit(V9, ['sha512-supports-color', 'sha512-supports-color-republished']);
    expect(diff(V9, after)).toEqual({ kind: 'importers', importers: ['packages/b'], changes: [] });
  });

  it('reports the root importer as "" and an unchanged lockfile as no importers', () => {
    expect(diff(V9, edit(V9, ['        version: 5.4.5', '        version: 5.4.6']))).toMatchObject({ kind: 'importers', importers: [''] });
    expect(diff(V9, V9)).toEqual({ kind: 'importers', importers: [], changes: [] });
  });

  it('counts an importer that was added or removed (a new or deleted workspace package)', () => {
    const after = edit(V9, ['  packages/c:\n', '  packages/d:\n    dependencies: {}\n\n  packages/c:\n']);
    expect(diff(V9, after)).toMatchObject({ importers: ['packages/d'] });
    expect(diff(after, V9)).toMatchObject({ importers: ['packages/d'] });
  });

  it('describes additions and removals', () => {
    const after = edit(
      V9,
      ['      left-pad:\n        specifier: ^1.3.0\n        version: 1.3.0\n', '      chalk:\n        specifier: ^5.0.0\n        version: 5.3.0\n'],
      ['  left-pad@1.3.0:\n    resolution: {integrity: sha512-left-pad}', '  chalk@5.3.0:\n    resolution: {integrity: sha512-chalk}'],
      ['  left-pad@1.3.0: {}', '  chalk@5.3.0: {}'],
    );
    expect(diff(V9, after)).toEqual({ kind: 'importers', importers: ['packages/c'], changes: ['+ chalk 5.3.0', '- left-pad 1.3.0'] });
  });

  it('maps importers of a lockfile in a subdirectory to repo-relative directories', () => {
    const after = edit(V9, ['sha512-left-pad', 'sha512-left-pad-2'], ['        version: 5.4.5', '        version: 5.4.6']);
    expect(diff(V9, after, {}, 'web/pnpm-lock.yaml')).toMatchObject({ importers: ['web', 'web/packages/c'] });
  });

  it.each([
    ['a settings change', edit(V9, ['autoInstallPeers: true', 'autoInstallPeers: false']), /`settings` section changed/],
    ['a new overrides section', edit(V9, ['importers:\n', 'overrides:\n  ms: 2.1.3\n\nimporters:\n']), /`overrides` section changed/],
    ['a format change', edit(V9, ["lockfileVersion: '9.0'", "lockfileVersion: '6.0'"]), /lockfile format changed \(v9 → v6\)/],
  ])('falls back to everything on %s', (_, after, reason) => {
    expect(diff(V9, after)).toEqual({ kind: 'all', reason: expect.stringMatching(reason) });
  });

  it.each([
    ['added', undefined, V9, /pnpm-lock\.yaml was added/],
    ['deleted', V9, undefined, /pnpm-lock\.yaml was deleted/],
    ['unparseable', V9, 'importers: [unclosed', /could not parse pnpm-lock\.yaml at head/],
    ['an old format', "lockfileVersion: '5.4'\nimporters: {}\n", V9, /lockfileVersion 5\.4 is not analyzed/],
    ['a single-project lockfile', "lockfileVersion: '6.0'\ndependencies: {}\n", "lockfileVersion: '6.0'\ndependencies: {}\n", /single-project/],
  ])('falls back to everything when the lockfile is %s', (_, before, after, reason) => {
    expect(diff(before, after)).toEqual({ kind: 'all', reason: expect.stringMatching(reason) });
  });

  describe('hoisting (a hoisted dependency is visible to packages that never declared it)', () => {
    const bump = edit(V9, ['sha512-left-pad', 'sha512-left-pad-2']);

    it.each([
      ['shamefully-hoist in .npmrc', { '.npmrc': '# comment\nshamefully-hoist=true\n' }, /node_modules is hoisted \(shamefully-hoist in \.npmrc\)/],
      ['node-linker=hoisted in .npmrc', { '.npmrc': 'node-linker = hoisted' }, /node-linker=hoisted/],
      ['nodeLinker in pnpm-workspace.yaml', { 'pnpm-workspace.yaml': 'packages: ["packages/*"]\nnodeLinker: hoisted\n' }, /nodeLinker: hoisted/],
      ['shamefullyHoist in pnpm-workspace.yaml', { 'pnpm-workspace.yaml': 'shamefullyHoist: true\n' }, /shamefullyHoist/],
    ])('everything, with %s', (_, config, reason) => {
      expect(diff(V9, bump, config)).toEqual({ kind: 'all', reason: expect.stringMatching(reason) });
    });

    it('everything when a publicly hoisted package changes: the defaults, plus configured patterns', () => {
      expect(diff(V9, bump, { '.npmrc': 'public-hoist-pattern[]=*left-pad*' })).toEqual({ kind: 'all', reason: expect.stringMatching(/^left-pad changed, and pnpm hoists it/) });
      expect(diff(V9, bump, { 'pnpm-workspace.yaml': 'publicHoistPattern: ["left-*"]' })).toMatchObject({ kind: 'all' });
      expect(diff(V9, bump, { '.npmrc': 'public-hoist-pattern[]=*left-pad*\npublic-hoist-pattern[]=!left-pad' })).toMatchObject({ kind: 'importers' });
      // A commented-out setting is not a setting.
      expect(diff(V9, bump, { '.npmrc': '# shamefully-hoist=true\n; node-linker=hoisted' })).toMatchObject({ kind: 'importers', importers: ['packages/c'] });
    });

    it('ignores hoisting config when nothing installed changed (an importer-only edit)', () => {
      const after = edit(V9, ['        specifier: ^1.3.0', '        specifier: ~1.3.0']);
      expect(diff(V9, after, { '.npmrc': 'shamefully-hoist=true' })).toEqual({ kind: 'importers', importers: ['packages/c'], changes: [] });
    });
  });

  describe('pnpm 11+ multi-document lockfiles (an env document first)', () => {
    const env = (pnpm: string) => `---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: ${pnpm}
        version: ${pnpm}

packages:

  pnpm@${pnpm}:
    resolution: {integrity: sha512-pnpm-${pnpm}}

snapshots:

  pnpm@${pnpm}: {}

---
`;
    // Regression: tRPC and Vite lockfiles failed to parse ("multiple documents"), so every bump ran everything.
    it('analyzes the main document and ignores an unchanged env document', () => {
      expect(diff(env('12.4.1') + V9, env('12.4.1') + edit(V9, ['sha512-left-pad', 'sha512-left-pad-2']))).toMatchObject({ kind: 'importers', importers: ['packages/c'] });
    });

    it('selects everything when the package manager itself changes', () => {
      expect(diff(env('12.4.1') + V9, env('12.15.0') + V9)).toEqual({ kind: 'all', reason: 'the package manager changed (pnpm 12.4.1 → 12.15.0)' });
      expect(diff(V9, env('12.4.1') + V9)).toEqual({ kind: 'all', reason: 'the package manager changed (pnpm (unpinned) → 12.4.1)' });
    });

    it('refuses a stream with two lockfile documents instead of guessing', () => {
      expect(diff(V9, `${V9}---\n${V9}`)).toEqual({ kind: 'all', reason: expect.stringMatching(/has 2 lockfile documents/) });
    });
  });

  it('a catalog bump narrows like any other bump: the importers using it record the new version', () => {
    const catalog = (version: string) => `catalogs:\n  default:\n    ms:\n      specifier: ^2.1.0\n      version: ${version}\n\nimporters:\n`;
    const before = edit(V9, ['importers:\n', catalog('2.1.2')]);
    const after = edit(
      before,
      ['      version: 2.1.2\n\nimporters', '      version: 2.1.3\n\nimporters'],
      ['        version: 2.1.2', '        version: 2.1.3'],
      ['ms@2.1.2:\n    resolution: {integrity: sha512-ms-2.1.2}', 'ms@2.1.3:\n    resolution: {integrity: sha512-ms-2.1.3}'],
      ['      ms: 2.1.2', '      ms: 2.1.3'],
      ['  ms@2.1.2: {}', '  ms@2.1.3: {}'],
    );
    expect(diff(before, after)).toEqual({ kind: 'importers', importers: ['packages/a', 'packages/b'], changes: ['ms 2.1.2 → 2.1.3'] });
  });

  it('reads v6 lockfiles (`/name@version` keys, dependencies inside `packages`)', () => {
    const v6 = `lockfileVersion: '6.0'
importers:
  packages/a:
    dependencies:
      ms:
        specifier: ^2.1.2
        version: 2.1.2
  packages/b:
    dependencies:
      debug:
        specifier: ^4.3.4
        version: 4.3.4
packages:
  /debug@4.3.4:
    resolution: {integrity: sha512-debug}
    dependencies:
      ms: 2.1.2
  /ms@2.1.2:
    resolution: {integrity: sha512-ms}
`;
    expect(diff(v6, edit(v6, ['sha512-debug', 'sha512-debug-2']))).toEqual({ kind: 'importers', importers: ['packages/b'], changes: [] });
    expect(diff(v6, edit(v6, ['sha512-ms', 'sha512-ms-2']))).toMatchObject({ importers: ['packages/a', 'packages/b'] });
  });

  it('handles only pnpm-lock.yaml, and asks for the layout config next to it and at the root', () => {
    expect(analyzer.supports('pnpm-lock.yaml')).toBe(true);
    expect(analyzer.supports('web/pnpm-lock.yaml')).toBe(true);
    expect(analyzer.supports('package-lock.json')).toBe(false);
    expect(analyzer.layoutConfigPaths('web/pnpm-lock.yaml')).toEqual(['.npmrc', 'pnpm-workspace.yaml', 'web/.npmrc', 'web/pnpm-workspace.yaml']);
  });
});

describe('depPath (pnpm refToRelative)', () => {
  it.each([
    ['2.1.2', 'ms', 9, 'ms@2.1.2'],
    ['3.2.7(@types/node@22.20.5)(yaml@2.9.1)', 'vitest', 9, 'vitest@3.2.7(@types/node@22.20.5)(yaml@2.9.1)'],
    ['22.20.5', '@types/node', 9, '@types/node@22.20.5'],
    ['string-width@4.2.3', 'string-width-cjs', 9, 'string-width@4.2.3'], // npm: alias
    ['@scope/real@1.0.0', 'alias', 9, '@scope/real@1.0.0'],
    ['link:../core', '@depwave/core', 9, undefined],
    ['file:../local', 'local', 9, 'local@file:../local'],
    ['https://example.com/x-1.0.0.tgz', 'x', 9, 'x@https://example.com/x-1.0.0.tgz'],
    ['1.0.0(react@18.2.0)', 'swr', 9, 'swr@1.0.0(react@18.2.0)'],
    ['2.1.2', 'ms', 6, '/ms@2.1.2'],
    ['/string-width@4.2.3', 'string-width-cjs', 6, '/string-width@4.2.3'],
    ['file:packages/x', 'x', 6, 'file:packages/x'],
    ['link:../core', 'core', 6, undefined],
  ] as const)('%s (%s, v%d) → %s', (ref, name, version, expected) => {
    expect(depPath(ref, name, version)).toBe(expected);
  });
});
