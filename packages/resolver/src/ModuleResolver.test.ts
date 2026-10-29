import type { Workspace, WorkspacePackage } from '@depwave/core';
import { describe, expect, it } from 'vitest';
import { ModuleResolver } from './ModuleResolver.js';
import { VirtualFileSystem } from './vfs.js';

/** In-memory repo: every key is a tracked file; values are contents (only config files are ever read). */
function repo(files: Record<string, string | object>, packages: Array<[name: string, root: string, manifest?: string]> = []) {
  const contents = new Map(Object.entries(files).map(([path, c]) => [path, typeof c === 'string' ? c : JSON.stringify(c)]));
  const workspace: Workspace = {
    tools: [],
    packages: packages.map(([name, root, manifest]): WorkspacePackage => ({ name, root, manifestPath: manifest ?? `${root}/package.json`, dependencies: [] })),
  };
  return new ModuleResolver(new VirtualFileSystem(contents.keys(), contents), workspace);
}

const target = (r: ReturnType<ModuleResolver['resolve']>) =>
  r.kind === 'file' ? r.path : r.kind === 'external' ? `external:${r.packageName}` : `unresolved:${r.reason}`;

describe('relative specifiers', () => {
  it('records the complete, ordered probe list, including every missing candidate', () => {
    const r = repo({ 'src/config/index.ts': '' }).resolve('src/features/settings.ts', '../config');
    expect(target(r)).toBe('src/config/index.ts');
    expect(r.probed).toEqual([
      'src/config',
      'src/config.ts',
      'src/config.tsx',
      'src/config.d.ts',
      'src/config.mts',
      'src/config.cts',
      'src/config.js',
      'src/config.jsx',
      'src/config.mjs',
      'src/config.cjs',
      'src/config.json',
      'src/config/package.json',
      'src/config/index.ts',
    ]);
  });

  it('a file beats a directory index (the ts-paths shadowing rule)', () => {
    const r = repo({ 'src/utils.ts': '', 'src/utils/index.ts': '' }).resolve('src/features/legacy.ts', '../utils');
    expect(target(r)).toBe('src/utils.ts');
    expect(r.probed).toEqual(['src/utils', 'src/utils.ts']); // stops at the first hit: index.ts can't matter
  });

  it.each([
    [{ 'src/x.ts': '', 'src/x.tsx': '', 'src/x.js': '' }, './x', 'src/x.ts'],
    [{ 'src/x.tsx': '', 'src/x.js': '' }, './x', 'src/x.tsx'],
    [{ 'src/x.ts': '', 'src/x.js': '' }, './x.js', 'src/x.ts'], // TS ESM: .js means the .ts source
    [{ 'src/x.js': '' }, './x.js', 'src/x.js'],
    [{ 'src/App.tsx': '' }, './App.jsx', 'src/App.tsx'],
    [{ 'src/data.json': '' }, './data.json', 'src/data.json'],
    [{ 'src/x.ts': '' }, './x.ts', 'src/x.ts'],
    [{ 'src/index.ts': '' }, '.', 'src/index.ts'],
    [{ 'src/index.ts': '' }, './', 'src/index.ts'],
    // Impact follows runtime: a hand-written declaration next to its JavaScript resolves to the JavaScript.
    // Regression (found by shadow mode): `./post-comment.mjs` linked to post-comment.d.mts, so edits to the code missed its tests.
    [{ 'src/x.mjs': '', 'src/x.d.mts': '' }, './x.mjs', 'src/x.mjs'],
    [{ 'src/x.cjs': '', 'src/x.d.cts': '' }, './x.cjs', 'src/x.cjs'],
    [{ 'src/x.js': '', 'src/x.d.ts': '' }, './x.js', 'src/x.js'],
    [{ 'src/x.js': '', 'src/x.d.ts': '' }, './x', 'src/x.js'],
    [{ 'src/x/index.js': '', 'src/x/index.d.ts': '' }, './x', 'src/x/index.js'],
    [{ 'src/x.d.ts': '' }, './x', 'src/x.d.ts'], // a declaration alone (ambient types) stays
    [{ 'src/x.ts': '', 'src/x.d.ts': '', 'src/x.js': '' }, './x.js', 'src/x.ts'], // TS source still wins
  ])('%o: %s → %s', (files, specifier, expected) => {
    expect(target(repo(files).resolve('src/file.ts', specifier))).toBe(expected);
  });

  it('resolves `..` to the parent index and normalizes Windows-style importer paths', () => {
    expect(target(repo({ 'src/index.ts': '' }).resolve('src\\a\\b.ts', '..'))).toBe('src/index.ts');
  });

  it('follows a directory package.json main field before index', () => {
    const r = repo({ 'lib/legacy/package.json': { main: './entry.js' }, 'lib/legacy/entry.js': '', 'lib/legacy/index.js': '' });
    expect(target(r.resolve('src/a.ts', '../lib/legacy'))).toBe('lib/legacy/entry.js');
  });

  it('reports not-found, and unsupported syntax for absolute paths and URLs', () => {
    const r = repo({ 'src/a.ts': '' });
    expect(target(r.resolve('src/a.ts', './missing'))).toBe('unresolved:not-found');
    expect(r.resolve('a.ts', '../../outside')).toEqual({ kind: 'unresolved', reason: 'not-found', probed: [] });
    expect(target(r.resolve('src/a.ts', '/abs/path'))).toBe('unresolved:unsupported-syntax');
    expect(target(r.resolve('src/a.ts', 'file:///etc/x.js'))).toBe('unresolved:unsupported-syntax');
    expect(target(r.resolve('src/a.ts', 'C:\\abs\\x.ts'))).toBe('unresolved:unsupported-syntax');
  });
});

describe('bare specifiers', () => {
  it('classifies builtins and external packages without touching node_modules', () => {
    const r = repo({});
    expect(r.resolve('a.ts', 'fs')).toMatchObject({ kind: 'external', packageName: 'node:fs', specifier: 'fs' });
    expect(r.resolve('a.ts', 'node:path')).toMatchObject({ kind: 'external', packageName: 'node:path' });
    expect(r.resolve('a.ts', 'fs/promises')).toMatchObject({ kind: 'external', packageName: 'node:fs/promises' });
    expect(r.resolve('a.ts', 'react')).toEqual({ kind: 'external', packageName: 'react', specifier: 'react', probed: ['tsconfig.json', 'jsconfig.json'] });
    expect(r.resolve('a.ts', '@scope/pkg/sub/x')).toMatchObject({ kind: 'external', packageName: '@scope/pkg', specifier: '@scope/pkg/sub/x' });
  });
});

describe('tsconfig paths and baseUrl', () => {
  const tsconfig = {
    compilerOptions: {
      baseUrl: '.',
      paths: {
        '@lib/*': ['src/lib/*'],
        '@lib/special': ['src/special.ts'],
        '@app/*': ['src/app/*', 'src/legacy/*'],
        '@/*': ['src/*'],
        '@/components/*': ['src/ui/*'],
      },
    },
  };
  const r = repo({
    'tsconfig.json': tsconfig,
    'src/lib/x.ts': '',
    'src/lib/special.ts': '',
    'src/special.ts': '',
    'src/legacy/y.ts': '',
    'src/ui/Button.tsx': '',
    'src/components/Button.tsx': '',
    'src/utils/math.ts': '',
  });

  it.each([
    ['@lib/x', 'src/lib/x.ts'],
    ['@lib/special', 'src/special.ts'], // exact key beats the pattern
    ['@app/y', 'src/legacy/y.ts'], // falls through substitutions in order
    ['@/components/Button', 'src/ui/Button.tsx'], // longest prefix wins
    ['@/utils/math', 'src/utils/math.ts'],
    ['src/utils/math', 'src/utils/math.ts'], // baseUrl
    ['@lib/nope', 'external:@lib/nope'], // unmatched alias falls through, like TS
  ])('%s → %s', (specifier, expected) => {
    expect(target(r.resolve('src/features/page.ts', specifier))).toBe(expected);
  });

  it('records baseUrl probes even for packages that end up external (a local file could shadow them)', () => {
    const result = r.resolve('src/a.ts', 'react');
    expect(target(result)).toBe('external:react');
    expect(result.probed).toContain('react.ts');
    expect(result.probed).toContain('react/index.ts');
  });

  it('resolves paths relative to the declaring config when there is no baseUrl, through extends', () => {
    const r2 = repo({
      'configs/tsconfig.base.json': `{
        // JSONC: comments and trailing commas are fine
        "compilerOptions": { "paths": { "~/*": ["../src/*"], }, },
      }`,
      'tsconfig.json': { extends: './configs/tsconfig.base.json' },
      'src/a.ts': '',
    });
    expect(target(r2.resolve('src/b.ts', '~/a'))).toBe('src/a.ts');
  });

  it('uses the nearest tsconfig only: a nested config without paths hides the root aliases', () => {
    const r3 = repo({ 'tsconfig.json': tsconfig, 'packages/a/tsconfig.json': { compilerOptions: {} }, 'src/lib/x.ts': '' });
    expect(target(r3.resolve('packages/a/src/i.ts', '@lib/x'))).toBe('external:@lib/x');
    expect(target(r3.resolve('src/i.ts', '@lib/x'))).toBe('src/lib/x.ts');
  });

  it('survives an extends cycle', () => {
    const r4 = repo({ 'tsconfig.json': { extends: './b.json', compilerOptions: { baseUrl: '.' } }, 'b.json': '{}', 'x.ts': '' });
    expect(target(r4.resolve('a.ts', 'x'))).toBe('x.ts');
  });
});

describe('workspace packages (no node_modules anywhere)', () => {
  it('exports: string sugar, subpaths, patterns, null exclusions and unexported subpaths', () => {
    const r = repo(
      {
        'packages/ui/package.json': {
          name: '@acme/ui',
          exports: { '.': './src/index.ts', './button': './src/Button.tsx', './icons/*': './src/icons/*.tsx', './internal/*': null },
        },
        'packages/ui/src/index.ts': '',
        'packages/ui/src/Button.tsx': '',
        'packages/ui/src/icons/Star.tsx': '',
        'packages/ui/src/internal/x.ts': '',
        'packages/tiny/package.json': { name: 'tiny', exports: './main.ts' },
        'packages/tiny/main.ts': '',
      },
      [
        ['@acme/ui', 'packages/ui'],
        ['tiny', 'packages/tiny'],
      ],
    );
    expect(target(r.resolve('apps/web/a.ts', '@acme/ui'))).toBe('packages/ui/src/index.ts');
    expect(target(r.resolve('apps/web/a.ts', '@acme/ui/button'))).toBe('packages/ui/src/Button.tsx');
    expect(target(r.resolve('apps/web/a.ts', '@acme/ui/icons/Star'))).toBe('packages/ui/src/icons/Star.tsx');
    expect(target(r.resolve('apps/web/a.ts', '@acme/ui/internal/x'))).toBe('unresolved:not-found');
    expect(target(r.resolve('apps/web/a.ts', '@acme/ui/src/index.ts'))).toBe('unresolved:not-found'); // not exported
    expect(target(r.resolve('apps/web/a.ts', 'tiny'))).toBe('packages/tiny/main.ts');
  });

  it('conditions: object order is priority; tsconfig customConditions are honoured', () => {
    const files = {
      'packages/env/package.json': { name: 'env', exports: { '.': { development: './src/dev.ts', default: './src/prod.ts' } } },
      'packages/env/src/dev.ts': '',
      'packages/env/src/prod.ts': '',
    };
    const pkgs: Array<[string, string]> = [['env', 'packages/env']];
    expect(target(repo(files, pkgs).resolve('app/a.ts', 'env'))).toBe('packages/env/src/prod.ts');
    const withCondition = repo({ ...files, 'app/tsconfig.json': { compilerOptions: { customConditions: ['development'] } } }, pkgs);
    expect(target(withCondition.resolve('app/a.ts', 'env'))).toBe('packages/env/src/dev.ts');
  });

  it('every distinct file a conditional export or main field can load is listed, the first as `path`', () => {
    const also = (r: ReturnType<ModuleResolver['resolve']>) => (r.kind === 'file' ? [r.path, ...(r.also ?? [])] : []);
    const r = repo(
      {
        'packages/dual/package.json': { name: 'dual', exports: { '.': { types: './index.d.ts', import: './esm.mjs', require: './cjs.cjs' } } },
        'packages/dual/index.d.ts': '',
        'packages/dual/esm.mjs': '',
        'packages/dual/cjs.cjs': '',
        // Built outputs that all map back to one source stay one file.
        'packages/built/package.json': { name: 'built', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.mjs', require: './dist/index.cjs' } } },
        'packages/built/src/index.ts': '',
        'packages/legacy/package.json': { name: 'legacy', types: './index.d.ts', module: './index.mjs', main: './index.js' },
        'packages/legacy/index.d.ts': '',
        'packages/legacy/index.mjs': '',
        'packages/legacy/index.js': '',
        'package.json': { name: 'root', imports: { '#impl': { node: './src/node.ts', default: './src/web.ts' } } },
        'src/node.ts': '',
        'src/web.ts': '',
      },
      [['dual', 'packages/dual'], ['built', 'packages/built'], ['legacy', 'packages/legacy']],
    );
    expect(also(r.resolve('app/a.ts', 'dual'))).toEqual(['packages/dual/index.d.ts', 'packages/dual/esm.mjs', 'packages/dual/cjs.cjs']);
    expect(r.resolve('app/a.ts', 'built')).toMatchObject({ kind: 'file', path: 'packages/built/src/index.ts' });
    expect(r.resolve('app/a.ts', 'built')).not.toHaveProperty('also');
    expect(also(r.resolve('app/a.ts', 'legacy'))).toEqual(['packages/legacy/index.d.ts', 'packages/legacy/index.mjs', 'packages/legacy/index.js']);
    expect(also(r.resolve('src/a.ts', '#impl'))).toEqual(['src/node.ts', 'src/web.ts']);
  });

  it('maps missing build outputs back to sources via tsconfig outDir/rootDir (like this repo)', () => {
    const r = repo(
      {
        'packages/core/package.json': { name: '@depwave/core', exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } } },
        'packages/core/tsconfig.json': { compilerOptions: { outDir: 'dist', rootDir: 'src' } },
        'packages/core/src/index.ts': '',
      },
      [['@depwave/core', 'packages/core']],
    );
    const result = r.resolve('packages/git/src/GitService.ts', '@depwave/core');
    expect(target(result)).toBe('packages/core/src/index.ts');
    expect(result.probed).toEqual(expect.arrayContaining(['packages/core/dist/index.d.ts', 'packages/core/dist/index.js']));
  });

  it('maps conventional output dirs to src/ when there is no tsconfig outDir', () => {
    const r = repo({ 'libs/util/package.json': { name: 'build-util', main: './build/main.js' }, 'libs/util/src/main.ts': '' }, [['build-util', 'libs/util']]);
    expect(target(r.resolve('a.ts', 'build-util'))).toBe('libs/util/src/main.ts');
  });

  it('a workspace package named like a Node builtin still loses to the builtin (Node semantics)', () => {
    const r = repo({ 'libs/util/package.json': { name: 'util' }, 'libs/util/index.ts': '' }, [['util', 'libs/util']]);
    expect(target(r.resolve('a.ts', 'util'))).toBe('external:node:util');
  });

  it('without exports: main fields, then index; subpaths resolve as files', () => {
    const r = repo(
      {
        'packages/a/package.json': { name: 'a', main: './lib/index.js' },
        'packages/a/lib/index.js': '',
        'packages/b/package.json': { name: 'b' },
        'packages/b/index.ts': '',
        'packages/b/src/deep.ts': '',
      },
      [
        ['a', 'packages/a'],
        ['b', 'packages/b'],
      ],
    );
    expect(target(r.resolve('x.ts', 'a'))).toBe('packages/a/lib/index.js');
    expect(target(r.resolve('x.ts', 'b'))).toBe('packages/b/index.ts');
    expect(target(r.resolve('x.ts', 'b/src/deep'))).toBe('packages/b/src/deep.ts');
  });

  it('never confuses a package with one whose name it prefixes', () => {
    const r = repo(
      { 'p/ui/index.ts': '', 'p/ui-kit/index.ts': '', 'p/ui/package.json': { name: '@acme/ui' }, 'p/ui-kit/package.json': { name: '@acme/ui-kit' } },
      [
        ['@acme/ui', 'p/ui'],
        ['@acme/ui-kit', 'p/ui-kit'],
      ],
    );
    expect(target(r.resolve('x.ts', '@acme/ui-kit'))).toBe('p/ui-kit/index.ts');
    expect(target(r.resolve('x.ts', '@acme/ui'))).toBe('p/ui/index.ts');
  });

  it('resolves Nx projects that only have project.json', () => {
    const r = repo({ 'apps/web/project.json': { name: 'web' }, 'apps/web/index.ts': '' }, [['web', 'apps/web', 'apps/web/project.json']]);
    expect(target(r.resolve('x.ts', 'web'))).toBe('apps/web/index.ts');
  });
});

describe('#imports', () => {
  const r = repo({
    'package.json': { name: 'root', imports: { '#utils/*': './src/utils/*.ts', '#dep': 'lodash', '#cond': { node: './src/node.ts', default: './src/web.ts' } } },
    'src/utils/math.ts': '',
    'src/node.ts': '',
  });

  it.each([
    ['#utils/math', 'src/utils/math.ts'],
    ['#dep', 'external:lodash'],
    ['#cond', 'src/node.ts'],
    ['#missing', 'unresolved:not-found'],
  ])('%s → %s', (specifier, expected) => {
    expect(target(r.resolve('src/features/a.ts', specifier))).toBe(expected);
  });
});

describe('determinism and caching', () => {
  it('returns identical probe lists on repeated calls and across files sharing cached config lookups', () => {
    const r = repo({ 'tsconfig.json': { compilerOptions: { baseUrl: 'src' } }, 'src/a.ts': '', 'src/b.ts': '' });
    const first = r.resolve('src/a.ts', 'react');
    expect(r.resolve('src/a.ts', 'react')).toEqual(first);
    expect(r.resolve('src/b.ts', 'react')).toEqual(first); // the tsconfig lookup is cached, but its probes are replayed
    expect(first.probed.slice(0, 3)).toEqual(['src/tsconfig.json', 'src/jsconfig.json', 'tsconfig.json']);
  });
});

describe('configHash', () => {
  const base = {
    'tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] }, strict: true } },
    'package.json': { name: 'app', imports: { '#x': './src/x.ts' } },
    'packages/p/package.json': { name: 'p', exports: './src/index.ts' },
    'src/a/one.ts': '',
    'src/b/two.ts': '',
  };
  const pkgs: Array<[string, string]> = [['p', 'packages/p']];
  const hash = (files: Record<string, string | object>, from = 'src/a/one.ts') => repo(files, pkgs).configHash(from);
  const original = hash(base);

  it('is stable: same config → same hash, across directories and formatting', () => {
    expect(hash(base)).toBe(original);
    expect(hash(base, 'src/b/two.ts')).toBe(original);
    expect(hash({ ...base, 'tsconfig.json': JSON.stringify(base['tsconfig.json'], null, 8) })).toBe(original);
    expect(hash({ ...base, 'src/a/new-file.ts': '' })).toBe(original);
  });

  it('ignores compiler options that cannot affect resolution', () => {
    expect(hash({ ...base, 'tsconfig.json': { compilerOptions: { ...base['tsconfig.json'].compilerOptions, strict: false } } })).toBe(original);
  });

  it.each([
    ['tsconfig paths', { 'tsconfig.json': { compilerOptions: { baseUrl: '.', paths: { '@/*': ['lib/*'] } } } }],
    ['tsconfig baseUrl', { 'tsconfig.json': { compilerOptions: { baseUrl: 'src', paths: { '@/*': ['src/*'] } } } }],
    ['moduleResolution', { 'tsconfig.json': { compilerOptions: { ...base['tsconfig.json'].compilerOptions, moduleResolution: 'node16' } } }],
    ['a nearer tsconfig', { 'src/a/tsconfig.json': {} }],
    ['package.json imports', { 'package.json': { name: 'app', imports: { '#x': './src/y.ts' } } }],
    ['a workspace package exports map', { 'packages/p/package.json': { name: 'p', exports: './src/main.ts' } }],
  ])('changes when %s changes', (_label, change) => {
    expect(hash({ ...base, ...change })).not.toBe(original);
  });
});

describe('real-world regressions (found by running depwave on tRPC and Vite)', () => {
  it('tRPC: tsconfig extends a workspace package that uses ${configDir}; dist/src/index.js maps to src/index.ts', () => {
    const r = repo(
      {
        'tooling/tsconfig/package.json': { name: '@monotest/tsconfig' },
        'tooling/tsconfig/base.json': { compilerOptions: { outDir: '${configDir}/dist', rootDir: '${configDir}' } },
        'pkgs/trpc/package.json': { name: '@monotest/trpc', exports: { '.': { types: './dist/src/index.d.ts', default: './dist/src/index.js' } } },
        'pkgs/trpc/tsconfig.json': { extends: ['@monotest/tsconfig/base.json'] },
        'pkgs/trpc/src/index.ts': '',
      },
      [
        ['@monotest/tsconfig', 'tooling/tsconfig'],
        ['@monotest/trpc', 'pkgs/trpc'],
      ],
    );
    expect(target(r.resolve('pkgs/app/src/a.ts', '@monotest/trpc'))).toBe('pkgs/trpc/src/index.ts');
  });

  it('${configDir} in a shared base resolves per extending config, also in paths', () => {
    const r = repo({
      'configs/base.json': { compilerOptions: { paths: { '#lib/*': ['${configDir}/lib/*'] } } },
      'apps/a/tsconfig.json': { extends: '../../configs/base.json' },
      'apps/a/lib/x.ts': '',
      'apps/b/tsconfig.json': { extends: '../../configs/base.json' },
      'apps/b/lib/x.ts': '',
    });
    expect(target(r.resolve('apps/a/src/i.ts', '#lib/x'))).toBe('apps/a/lib/x.ts');
    expect(target(r.resolve('apps/b/src/i.ts', '#lib/x'))).toBe('apps/b/lib/x.ts');
  });

  it('without tsconfig, dist/ maps to the package root as well as src/', () => {
    const r = repo({ 'p/package.json': { name: 'p', main: './dist/lib/main.js' }, 'p/lib/main.ts': '' }, [['p', 'p']]);
    expect(target(r.resolve('x.ts', 'p'))).toBe('p/lib/main.ts');
  });

  it('Vite: a UTF-8 BOM in package.json / tsconfig.json does not break resolution', () => {
    const r = repo(
      {
        'p/package.json': `﻿${JSON.stringify({ name: 'bom-pkg', exports: './src/index.ts' })}`,
        'p/src/index.ts': '',
        'tsconfig.json': `﻿${JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } })}`,
        'src/a.ts': '',
      },
      [['bom-pkg', 'p']],
    );
    expect(target(r.resolve('x.ts', 'bom-pkg'))).toBe('p/src/index.ts');
    expect(target(r.resolve('x.ts', '@/a'))).toBe('src/a.ts');
  });

  it('Vite: bundler queries resolve to the file; a literal ? in an #imports key still wins', () => {
    const r = repo({
      'package.json': { name: 'app', imports: { '#question?mark': './q.js', '#hash': './h.js' } },
      'src/worker.js': '',
      'src/a.css': '',
      'q.js': '',
      'h.js': '',
    });
    expect(target(r.resolve('src/main.ts', './worker.js?worker'))).toBe('src/worker.js');
    expect(target(r.resolve('src/main.ts', './a.css?inline&lang=css'))).toBe('src/a.css');
    expect(target(r.resolve('src/main.ts', '#question?mark'))).toBe('q.js');
    expect(target(r.resolve('src/main.ts', '#hash?raw'))).toBe('h.js');
    const missing = r.resolve('src/main.ts', './gone.js?url');
    expect(target(missing)).toBe('unresolved:not-found');
    expect(missing.probed).toEqual(expect.arrayContaining(['src/gone.js?url', 'src/gone.js'])); // both attempts recorded
  });

  it('virtual and URL modules are external, not missing', () => {
    const r = repo({});
    expect(r.resolve('a.ts', 'virtual:pwa-register')).toMatchObject({ kind: 'external', packageName: 'virtual:' });
    expect(r.resolve('a.ts', 'https://esm.sh/react')).toMatchObject({ kind: 'external', packageName: 'https:' });
    expect(target(r.resolve('a.ts', 'file:///etc/x.js'))).toBe('unresolved:unsupported-syntax');
  });

  it('Vite: a package name shared by two workspace packages resolves to the one nearest the importer', () => {
    const r = repo(
      {
        'tests/packages/name/package.json': { name: 'mylib' },
        'tests/packages/name/index.ts': '',
        'tests/packages/module/package.json': { name: 'mylib' },
        'tests/packages/module/index.ts': '',
      },
      [
        ['mylib', 'tests/packages/name'],
        ['mylib', 'tests/packages/module'],
      ],
    );
    expect(target(r.resolve('tests/packages/module/test/a.ts', 'mylib'))).toBe('tests/packages/module/index.ts');
    expect(target(r.resolve('tests/packages/name/x.ts', 'mylib'))).toBe('tests/packages/name/index.ts');
  });
});
