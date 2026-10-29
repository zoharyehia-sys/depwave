import { describe, expect, it } from 'vitest';
import { changedSymbols } from '../diff/DiffAnalyzer.js';
import type { ExportFact, FileFacts, ImportFact, ReferenceFact, SymbolFact } from '../model/facts.js';
import type { Inventory } from '../model/workspace.js';
import { dirOf, resolveRelative } from '../paths.js';
import type { ResolverPort } from '../ports/resolver.js';
import { buildGraph } from './GraphBuilder.js';
import { ReExportResolver } from './ReExportResolver.js';

const loc = { line: 1, col: 1 };
const span = { startLine: 1, endLine: 1, startByte: 0, endByte: 0 };
const sym = (name: string, bodyHash = `h:${name}`, exported: SymbolFact['exported'] = true): SymbolFact => ({ name, kind: 'function', exported, span, bodyHash });
const local = (name: string, as = name): ExportFact => ({ kind: 'local', name: as, local: name, typeOnly: false });
const reexport = (from: string, name: string, as = name): ExportFact => ({ kind: 'reexport', name: as, local: name, from, typeOnly: false });
const star = (from: string): ExportFact => ({ kind: 'reexport-all', name: '*', from, typeOnly: false });
const named = (specifier: string, ...names: string[]): ImportFact => ({ kind: 'static', specifier, bindings: names.map((n) => ({ imported: n, local: n })), loc });
const ref = (from: string, to: string, kind: ReferenceFact['kind'] = 'call'): ReferenceFact => ({ kind, from, to, loc });

function facts(path: string, parts: Partial<Pick<FileFacts, 'imports' | 'exports' | 'symbols' | 'references' | 'moduleHash'>>): FileFacts {
  return { path, language: 'typescript', contentHash: `c:${path}`, parserVersion: 't', imports: [], exports: [], symbols: [], references: [], hasSideEffects: false, moduleHash: 'm', parseErrors: 0, ...parts };
}

/** Resolves './x' style specifiers against a set of known `.ts` files (enough for these tests). */
function resolverFor(paths: readonly string[]) {
  const known = new Set(paths);
  const resolve = (from: string, specifier: string): string | undefined => {
    if (!specifier.startsWith('.')) return undefined;
    const base = resolveRelative(dirOf(from), specifier);
    return base === undefined ? undefined : [`${base}.ts`, `${base}/index.ts`].find((p) => known.has(p));
  };
  const port: ResolverPort = {
    configHash: () => 'x',
    resolve: (from, specifier) => {
      const path = resolve(from, specifier);
      return path ? { kind: 'file', path, probed: [] } : { kind: 'external', packageName: specifier, specifier, probed: [] };
    },
  };
  return { resolve, port };
}

function world(files: FileFacts[]) {
  const map = new Map(files.map((f) => [f.path, f]));
  const { resolve, port } = resolverFor([...map.keys()]);
  return { map, resolver: new ReExportResolver({ facts: map, resolve }), port };
}

describe('ReExportResolver', () => {
  const { resolver } = world([
    facts('ui/Button.ts', { symbols: [sym('Button'), sym('Button.click')], exports: [local('Button')] }),
    facts('ui/Card.ts', { symbols: [sym('Card'), sym('helper', 'h', false)], exports: [local('Card'), local('Card', 'default')] }),
    facts('ui/forms/Input.ts', { symbols: [sym('Input')], exports: [local('Input')] }),
    facts('ui/forms/index.ts', { exports: [star('./Input')] }),
    facts('ui/index.ts', { exports: [star('./Button'), reexport('./Card', 'default', 'Card'), star('./forms'), star('./Card')] }),
    facts('ui/cycle-a.ts', { exports: [star('./cycle-b')] }),
    facts('ui/cycle-b.ts', { exports: [star('./cycle-a')] }),
    facts('ui/relay.ts', { imports: [named('./Button', 'Button')], exports: [local('Button', 'Relayed')] }),
    facts('ui/cjs.ts', { exports: [{ kind: 'local', name: 'default', local: 'default', typeOnly: false }] }),
    facts('app/page.ts', { imports: [named('../ui/index', 'Button', 'Card'), { kind: 'static', specifier: '../ui/index', bindings: [{ imported: '*', local: 'ui' }], loc }] }),
  ]);

  it('binds through nested `export *` barrels to the defining symbol', () => {
    expect(resolver.exported('ui/index.ts', 'Button')).toEqual({ kind: 'symbol', id: 'sym:ui/Button.ts#Button' });
    expect(resolver.exported('ui/index.ts', 'Input')).toEqual({ kind: 'symbol', id: 'sym:ui/forms/Input.ts#Input' });
  });

  it('follows renamed re-exports (`export { default as Card }`) and an explicit export beats `export *`', () => {
    expect(resolver.exported('ui/index.ts', 'Card')).toEqual({ kind: 'symbol', id: 'sym:ui/Card.ts#Card' });
  });

  it('`export *` never re-exports default, and unknown names are not exported', () => {
    expect(resolver.exported('ui/index.ts', 'default')).toBeUndefined();
    expect(resolver.exported('ui/index.ts', 'Nope')).toBeUndefined();
    expect(resolver.exported('ui/Card.ts', 'helper')).toBeUndefined(); // declared but not exported
  });

  it('terminates on export cycles', () => {
    expect(resolver.exported('ui/cycle-a.ts', 'X')).toBeUndefined();
  });

  it('follows `import { x }; export { x as y }` relays', () => {
    expect(resolver.exported('ui/relay.ts', 'Relayed')).toEqual({ kind: 'symbol', id: 'sym:ui/Button.ts#Button' });
  });

  it('binds imports, namespace members and class members from the importing side', () => {
    expect(resolver.imported('app/page.ts', 'Button', undefined)).toEqual({ kind: 'symbol', id: 'sym:ui/Button.ts#Button' });
    expect(resolver.imported('app/page.ts', 'Button', 'click')).toEqual({ kind: 'symbol', id: 'sym:ui/Button.ts#Button.click' });
    expect(resolver.imported('app/page.ts', 'Button', 'unknownMember')).toEqual({ kind: 'symbol', id: 'sym:ui/Button.ts#Button' });
    expect(resolver.imported('app/page.ts', 'ui', 'Input')).toEqual({ kind: 'symbol', id: 'sym:ui/forms/Input.ts#Input' });
  });

  it('widens to the whole module when the target is not statically known, and skips non-imports', () => {
    expect(resolver.imported('app/page.ts', 'ui', undefined)).toEqual({ kind: 'module', id: 'file:ui/index.ts' }); // namespace as a value
    expect(resolver.imported('app/page.ts', 'ui', 'Nope')).toEqual({ kind: 'module', id: 'file:ui/index.ts' });
    expect(resolver.exported('ui/cjs.ts', 'default')).toEqual({ kind: 'module', id: 'file:ui/cjs.ts' }); // CommonJS export
    expect(resolver.imported('app/page.ts', 'notAnImport', undefined)).toBeUndefined();
  });
});

describe('symbol-granularity graph', () => {
  const files = [
    facts('lib/a.ts', { symbols: [sym('a'), sym('b')], exports: [local('a'), local('b')], references: [ref('a', 'b')] }),
    facts('lib/index.ts', { exports: [star('./a')] }),
    facts('app/use.ts', {
      symbols: [sym('run'), sym('lazy')],
      imports: [named('../lib/index', 'a'), { kind: 'side-effect', specifier: './setup', bindings: [], loc }, { kind: 'dynamic', specifier: './chunk', bindings: [], from: 'lazy', loc }],
      references: [ref('run', 'a'), ref('<module>', 'run')],
    }),
    facts('app/setup.ts', {}),
    facts('app/chunk.ts', {}),
  ];
  const { map, port } = world(files);
  const inventory: Inventory = {
    rev: 'r',
    workspace: { tools: [], packages: [] },
    files: files.map((f) => ({ path: f.path, language: 'typescript' as const, contentHash: f.contentHash })),
    paths: files.map((f) => f.path),
  };
  const { graph } = buildGraph({ inventory, facts: map, resolver: port, granularity: 'symbol' });
  const out = (id: string) => [...graph.outEdges(id)].map((e) => `${e.kind} ${e.to}`).sort();

  it('gives every file a <module> node, PART_OF edges to its parts, and IN_MODULE edges from its symbols', () => {
    expect(out('file:lib/a.ts')).toEqual(['PART_OF sym:lib/a.ts#<module>', 'PART_OF sym:lib/a.ts#a', 'PART_OF sym:lib/a.ts#b']);
    expect(out('sym:lib/a.ts#b')).toEqual(['IN_MODULE sym:lib/a.ts#<module>']);
  });

  it('binds references to defining symbols (through the barrel) and keeps module-level imports at the right source', () => {
    expect(out('sym:app/use.ts#run')).toEqual(['CALLS sym:lib/a.ts#a', 'IN_MODULE sym:app/use.ts#<module>']);
    expect(out('sym:app/use.ts#lazy')).toEqual(['DYNAMIC_IMPORT file:app/chunk.ts', 'IN_MODULE sym:app/use.ts#<module>']);
    expect(out('sym:app/use.ts#<module>')).toEqual(['CALLS sym:app/use.ts#run', 'IMPORTS file:app/setup.ts', 'IMPORTS sym:lib/index.ts#<module>']);
    expect(out('sym:lib/a.ts#a')).toEqual(['CALLS sym:lib/a.ts#b', 'IN_MODULE sym:lib/a.ts#<module>']);
  });

  it('makes loading a module depend on its evaluation: value imports and re-exports, never type-only ones', () => {
    // use.ts loads the barrel (above), and the barrel loads every module it re-exports from.
    expect(out('sym:lib/index.ts#<module>')).toEqual(['IMPORTS sym:lib/a.ts#<module>']);
    const evalFiles = [
      facts('t.ts', { symbols: [sym('T')], exports: [local('T')] }),
      facts('u.ts', { imports: [{ kind: 'type', specifier: './t', bindings: [{ imported: 'T', local: 'T' }], loc }, { ...named('./t', 'T'), bindings: [{ imported: 'T', local: 'T', typeOnly: true }] }] }),
    ];
    const evalWorld = world(evalFiles);
    const built = buildGraph({
      inventory: { rev: 'r', workspace: { tools: [], packages: [] }, files: evalFiles.map((f) => ({ path: f.path, language: 'typescript' as const, contentHash: f.contentHash })), paths: evalFiles.map((f) => f.path) },
      facts: evalWorld.map,
      resolver: evalWorld.port,
      granularity: 'symbol',
    });
    expect([...built.graph.outEdges('sym:u.ts#<module>')]).toEqual([]);
  });

  it('makes module evaluation include initializers that run code on load', () => {
    const effectful = [facts('reg.ts', { symbols: [{ ...sym('handler'), effectful: true }, sym('pure')] })];
    const effWorld = world(effectful);
    const built = buildGraph({
      inventory: { rev: 'r', workspace: { tools: [], packages: [] }, files: [{ path: 'reg.ts', language: 'typescript', contentHash: 'c' }], paths: ['reg.ts'] },
      facts: effWorld.map,
      resolver: effWorld.port,
      granularity: 'symbol',
    });
    expect([...built.graph.outEdges('sym:reg.ts#<module>')].map((e) => `${e.kind} ${e.to}`)).toEqual(['PART_OF sym:reg.ts#handler']);
  });

  it('makes a class depend on its members, so instance method calls (unbindable without types) stay sound', () => {
    const cls = [facts('svc.ts', { symbols: [sym('Svc'), { ...sym('Svc.exec'), kind: 'method', parent: 'Svc' }] })];
    const clsWorld = world(cls);
    const built = buildGraph({
      inventory: { rev: 'r', workspace: { tools: [], packages: [] }, files: [{ path: 'svc.ts', language: 'typescript', contentHash: 'c' }], paths: ['svc.ts'] },
      facts: clsWorld.map,
      resolver: clsWorld.port,
      granularity: 'symbol',
    });
    expect([...built.graph.outEdges('sym:svc.ts#Svc')].map((e) => `${e.kind} ${e.to}`).sort()).toEqual([
      'IN_MODULE sym:svc.ts#<module>',
      'PART_OF sym:svc.ts#Svc.exec',
    ]);
  });

  it('has no file-to-file import edge for bound named imports (that is what used to widen at barrels)', () => {
    expect(out('file:app/use.ts').filter((e) => !e.startsWith('PART_OF'))).toEqual([]);
    expect(out('file:lib/index.ts')).toEqual(['PART_OF sym:lib/index.ts#<module>', 'RE_EXPORTS file:lib/a.ts']);
  });
});

describe('changedSymbols (structural diff)', () => {
  const before = facts('f.ts', { symbols: [sym('keep'), sym('edit', 'v1'), sym('gone'), sym('exp', 'same', false)] });

  it('reports symbols whose body, presence or export status changed; equal hashes are unchanged', () => {
    const after = facts('f.ts', { symbols: [sym('keep'), sym('edit', 'v2'), sym('added'), sym('exp', 'same', true)] });
    expect(changedSymbols('f.ts', before, after)).toEqual(['sym:f.ts#added', 'sym:f.ts#edit', 'sym:f.ts#exp', 'sym:f.ts#gone']);
  });

  it('a comment/whitespace-only edit (equal hashes everywhere) changes nothing', () => {
    expect(changedSymbols('f.ts', before, facts('f.ts', { symbols: [...before.symbols].reverse() }))).toEqual([]);
  });

  it('top-level code changes, or missing facts, mean the whole file changed', () => {
    expect(changedSymbols('f.ts', before, facts('f.ts', { symbols: before.symbols, moduleHash: 'other' }))).toBeUndefined();
    expect(changedSymbols('f.ts', undefined, before)).toBeUndefined();
  });
});
