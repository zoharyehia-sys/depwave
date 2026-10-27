import { describe, expect, it } from 'vitest';
import { NO_PACKAGE } from '../graph/DependencyGraph.js';
import type { ExportFact, FileFacts, ImportFact } from '../model/facts.js';
import { Confidence } from '../model/graph.js';
import type { Inventory } from '../model/workspace.js';
import type { ResolutionResult, ResolverPort } from '../ports/resolver.js';
import { buildGraph, globToRegExp } from './GraphBuilder.js';

const loc = { line: 1, col: 1 };
const imp = (fact: Partial<ImportFact>): ImportFact => ({ kind: 'static', bindings: [], loc, ...fact });

function facts(path: string, imports: ImportFact[] = [], exports: ExportFact[] = []): FileFacts {
  return { path, language: 'typescript', contentHash: `h:${path}`, parserVersion: 't', imports, exports, symbols: [], references: [], hasSideEffects: false, moduleHash: 'm', parseErrors: 0 };
}

type Answer = ResolutionResult extends infer R ? (R extends unknown ? Omit<R, 'probed'> : never) : never;

/** Resolver backed by a literal table: `${from}|${specifier}` → result. */
function resolver(table: Record<string, Answer>): ResolverPort {
  return {
    configHash: () => 'x',
    resolve: (from, specifier) => ({ ...(table[`${from}|${specifier}`] ?? { kind: 'unresolved', reason: 'not-found' }), probed: [] }) as ResolutionResult,
  };
}

function inventory(files: string[], extraPaths: string[] = []): Inventory {
  return {
    rev: 'r',
    workspace: {
      tools: ['pnpm'],
      packages: [
        { name: 'root', root: '', manifestPath: 'package.json', dependencies: [] },
        { name: 'app', root: 'app', manifestPath: 'app/package.json', dependencies: ['lib', 'react'] },
        { name: 'lib', root: 'lib', manifestPath: 'lib/package.json', dependencies: [] },
      ],
    },
    files: files.map((path) => ({ path, language: 'typescript' as const, contentHash: `h:${path}` })),
    paths: [...files, ...extraPaths].sort(),
  };
}

const edgesFrom = (g: ReturnType<typeof buildGraph>['graph'], path: string) =>
  [...g.outEdges(`file:${path}`)].map((e) => `${e.kind} ${e.to}${e.typeOnly ? ' (type)' : ''}${e.confidence === Confidence.likely ? ' (likely)' : ''}`).sort();

describe('buildGraph', () => {
  it('links static, type-only, re-export and dynamic imports; skips externals; records unresolved', () => {
    const files = ['app/a.ts', 'app/b.ts', 'app/types.ts', 'lib/index.ts', 'lib/x.ts'];
    const { graph, unresolved } = buildGraph({
      inventory: inventory(files),
      facts: new Map([
        [
          'app/a.ts',
          facts('app/a.ts', [
            imp({ specifier: './b' }),
            imp({ kind: 'type', specifier: './types' }),
            imp({ specifier: 'lib', bindings: [{ imported: 'X', local: 'X', typeOnly: true }] }),
            imp({ specifier: 'react' }),
            imp({ kind: 'dynamic', specifier: './b' }),
            imp({ specifier: './gone' }),
          ]),
        ],
        ['lib/index.ts', facts('lib/index.ts', [], [{ kind: 'reexport-all', name: '*', from: './x', typeOnly: false }])],
      ]),
      resolver: resolver({
        'app/a.ts|./b': { kind: 'file', path: 'app/b.ts' },
        'app/a.ts|./types': { kind: 'file', path: 'app/types.ts' },
        'app/a.ts|lib': { kind: 'file', path: 'lib/index.ts' },
        'app/a.ts|react': { kind: 'external', packageName: 'react', specifier: 'react' },
        'lib/index.ts|./x': { kind: 'file', path: 'lib/x.ts' },
      }),
    });

    expect(edgesFrom(graph, 'app/a.ts')).toEqual([
      'DYNAMIC_IMPORT file:app/b.ts',
      'IMPORTS file:app/b.ts',
      'IMPORTS file:app/types.ts (type)',
      'IMPORTS file:lib/index.ts (type)', // every binding type-only
    ]);
    expect(edgesFrom(graph, 'lib/index.ts')).toEqual(['RE_EXPORTS file:lib/x.ts']);
    expect(unresolved).toEqual([{ from: 'app/a.ts', specifier: './gone', reason: 'not-found' }]);
  });

  it('creates package nodes, workspace DEPENDS_ON edges and deepest-package ownership', () => {
    const { graph } = buildGraph({ inventory: inventory(['app/a.ts', 'lib/x.ts', 'scripts/s.ts']), facts: new Map(), resolver: resolver({}) });
    expect([...graph.outEdges('pkg:app')].filter((e) => e.kind === 'DEPENDS_ON').map((e) => e.to)).toEqual(['pkg:lib']); // react isn't a workspace package
    expect(graph.node('file:app/a.ts')).toMatchObject({ packageId: 'pkg:app' });
    expect(graph.node('file:scripts/s.ts')).toMatchObject({ packageId: 'pkg:root' });
    expect([...graph.filesOf('pkg:lib')].map((n) => n.path)).toEqual(['lib/x.ts']);
  });

  it('gives imported non-source files (styles, JSON) nodes so their edits count', () => {
    const { graph } = buildGraph({
      inventory: inventory(['app/a.ts'], ['app/a.css']),
      facts: new Map([['app/a.ts', facts('app/a.ts', [imp({ kind: 'side-effect', specifier: './a.css' })])]]),
      resolver: resolver({ 'app/a.ts|./a.css': { kind: 'file', path: 'app/a.css' } }),
    });
    expect(graph.node('file:app/a.css')).toMatchObject({ kind: 'file', packageId: 'pkg:app', contentHash: '' });
    expect(graph.node('file:app/a.css')).not.toHaveProperty('language');
  });

  it('expands template globs over every tracked path (assets included) as likely edges', () => {
    const { graph } = buildGraph({
      inventory: inventory(['app/i18n/load.ts', 'app/i18n/locales/en.ts', 'app/i18n/locales/he.ts', 'app/other/x.ts'], ['app/i18n/locales/en.json']),
      facts: new Map([['app/i18n/load.ts', facts('app/i18n/load.ts', [imp({ kind: 'dynamic', pattern: './locales/*.ts' })])]]),
      resolver: resolver({}),
    });
    expect(edgesFrom(graph, 'app/i18n/load.ts')).toEqual([
      'DYNAMIC_IMPORT file:app/i18n/locales/en.ts (likely)',
      'DYNAMIC_IMPORT file:app/i18n/locales/he.ts (likely)',
    ]);
  });

  it('turns a fully dynamic import into a wildcard dependency on its own package', () => {
    const { graph } = buildGraph({
      inventory: inventory(['lib/registry.ts', 'loose.ts'].concat()),
      facts: new Map([
        ['lib/registry.ts', facts('lib/registry.ts', [imp({ kind: 'dynamic' })])],
        ['loose.ts', facts('loose.ts', [imp({ kind: 'dynamic', pattern: '@scope/*' })])],
      ]),
      resolver: resolver({}),
    });
    expect([...graph.wildcardDependents('pkg:lib')]).toEqual(['file:lib/registry.ts']);
    expect([...graph.wildcardDependents('pkg:root')]).toEqual(['file:loose.ts']); // non-relative glob: also fully dynamic
    expect([...graph.wildcardDependents(NO_PACKAGE)]).toEqual([]);
  });
});

describe('globToRegExp', () => {
  it.each([
    ['src/locales/*.ts', 'src/locales/he.ts', true],
    ['src/locales/*.ts', 'src/locales/he.json', false],
    ['src/locales/*.ts', 'src/locales/nested/he.ts', true], // a substitution may contain '/'
    ['src/pages/*', 'src/pages/Home.tsx', true], // no extension: any extension…
    ['src/pages/*', 'src/pages/admin/index.ts', true], // …or a directory index
    ['src/a.b/*.ts', 'src/aXb/c.ts', false], // dots are literal
  ])('%s vs %s → %s', (pattern, path, expected) => {
    expect(globToRegExp(pattern).test(path)).toBe(expected);
  });
});
