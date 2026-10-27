import type { LanguageId } from '@depwave/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadTreeSitter, type TreeSitterRuntime } from '../../treeSitter.js';
import { simplifyGlob } from './extract.js';
import { TypeScriptAdapter, type JsLikeLanguage } from './TypeScriptAdapter.js';

let runtime: TreeSitterRuntime;
beforeAll(async () => {
  runtime = await loadTreeSitter();
});

function facts(source: string, language: JsLikeLanguage = 'typescript', path = 'src/file.ts') {
  const adapter = new TypeScriptAdapter(language);
  const tree = runtime.parserFor(adapter.grammar).parse(source)!;
  try {
    return adapter.extractFacts(tree, source, path);
  } finally {
    tree.delete();
  }
}

const imports = (src: string, lang?: JsLikeLanguage) => facts(src, lang).imports.map(({ loc: _loc, ...rest }) => rest);
const refs = (src: string, lang?: JsLikeLanguage) => facts(src, lang).references.map(({ kind, from, to }) => `${from} -${kind}-> ${to}`).sort();
const symbols = (src: string, lang?: JsLikeLanguage) => facts(src, lang).symbols.map((s) => [s.name, s.kind, s.exported]);

describe('imports', () => {
  it('default, named, aliased, namespace and type-only bindings', () => {
    expect(
      imports(`
        import React, { useState as useS, type FC } from 'react';
        import * as utils from './utils';
        import type { Props } from './types';
        import { "kebab-name" as kebab } from './weird';
      `),
    ).toEqual([
      {
        kind: 'static',
        specifier: 'react',
        bindings: [
          { imported: 'default', local: 'React' },
          { imported: 'useState', local: 'useS' },
          { imported: 'FC', local: 'FC', typeOnly: true },
        ],
      },
      { kind: 'static', specifier: './utils', bindings: [{ imported: '*', local: 'utils' }] },
      { kind: 'type', specifier: './types', bindings: [{ imported: 'Props', local: 'Props' }] },
      { kind: 'static', specifier: './weird', bindings: [{ imported: 'kebab-name', local: 'kebab' }] },
    ]);
  });

  it('side-effect imports and TS import-require', () => {
    expect(imports(`import './polyfills';\nimport fs = require('fs');`)).toEqual([
      { kind: 'side-effect', specifier: './polyfills', bindings: [] },
      { kind: 'require', specifier: 'fs', bindings: [{ imported: '*', local: 'fs' }] },
    ]);
  });

  it('dynamic imports: literal, glob from template, and fully dynamic', () => {
    expect(
      imports(`
        const a = () => import('./pages/Home');
        async function load(locale: string) { return import(\`./locales/\${locale}.json\`); }
        const b = (name: string) => import(name);
        const c = (dir: string) => import(\`\${dir}/index.ts\`);
        const d = () => import(\`./static.ts\`);
        const e = (a: string, b: string) => import(\`./x/\${a}\${b}/y.ts\`);
      `),
    ).toEqual([
      { kind: 'dynamic', specifier: './pages/Home', bindings: [], from: 'a' }, // enclosing symbol
      { kind: 'dynamic', pattern: './locales/*.json', bindings: [], from: 'load' },
      { kind: 'dynamic', bindings: [], from: 'b' },
      { kind: 'dynamic', bindings: [], from: 'c' }, // no static prefix: too vague to glob
      { kind: 'dynamic', specifier: './static.ts', bindings: [], from: 'd' },
      { kind: 'dynamic', pattern: './x/*/y.ts', bindings: [], from: 'e' },
    ]);
  });

  it('CommonJS require: whole module, destructured, nested and dynamic', () => {
    expect(
      imports(
        `
        const path = require('path');
        const { readFile, join: j } = require('node:fs');
        function lazy() { return require('./lazy'); }
        function plugin(name) { return require(name); }
      `,
        'javascript',
      ),
    ).toEqual([
      { kind: 'require', specifier: 'path', bindings: [{ imported: '*', local: 'path' }] },
      {
        kind: 'require',
        specifier: 'node:fs',
        bindings: [
          { imported: 'readFile', local: 'readFile' },
          { imported: 'join', local: 'j' },
        ],
      },
      { kind: 'require', specifier: './lazy', bindings: [], from: 'lazy' },
      { kind: 'require', bindings: [], from: 'plugin' },
    ]);
  });

  it('reports 1-based locations', () => {
    expect(facts(`\n\n  import x from './x';`).imports[0]?.loc).toEqual({ line: 3, col: 3 });
  });
});

describe('exports', () => {
  it('re-exports: all, namespace, named, aliased, default and type-only', () => {
    expect(
      facts(`
        export * from './a';
        export * as ns from './b';
        export { x, y as z, default as D } from './c';
        export type { T } from './d';
        export { type U, v } from './e';
      `).exports,
    ).toEqual([
      { kind: 'reexport-all', name: '*', from: './a', typeOnly: false },
      { kind: 'reexport-namespace', name: 'ns', from: './b', typeOnly: false },
      { kind: 'reexport', name: 'x', local: 'x', from: './c', typeOnly: false },
      { kind: 'reexport', name: 'z', local: 'y', from: './c', typeOnly: false },
      { kind: 'reexport', name: 'D', local: 'default', from: './c', typeOnly: false },
      { kind: 'reexport', name: 'T', local: 'T', from: './d', typeOnly: true },
      { kind: 'reexport', name: 'U', local: 'U', from: './e', typeOnly: true },
      { kind: 'reexport', name: 'v', local: 'v', from: './e', typeOnly: false },
    ]);
  });

  it('local declarations, export clauses (even before the declaration) and defaults', () => {
    const f = facts(`
      export { helper, internal as renamed };
      export const A = 1, B = 2;
      export function fn() {}
      export class Cls {}
      export interface I {}
      export type T = string;
      export enum E { X }
      function helper() {}
      const internal = 3;
      export default fn;
    `);
    expect(f.exports).toEqual([
      { kind: 'local', name: 'helper', local: 'helper', typeOnly: false },
      { kind: 'local', name: 'renamed', local: 'internal', typeOnly: false },
      { kind: 'local', name: 'A', local: 'A', typeOnly: false },
      { kind: 'local', name: 'B', local: 'B', typeOnly: false },
      { kind: 'local', name: 'fn', local: 'fn', typeOnly: false },
      { kind: 'local', name: 'Cls', local: 'Cls', typeOnly: false },
      { kind: 'local', name: 'I', local: 'I', typeOnly: true },
      { kind: 'local', name: 'T', local: 'T', typeOnly: true },
      { kind: 'local', name: 'E', local: 'E', typeOnly: false },
      { kind: 'local', name: 'default', local: 'fn', typeOnly: false },
    ]);
    expect(f.symbols.map((s) => [s.name, s.exported])).toEqual([
      ['A', true],
      ['B', true],
      ['fn', true], // named export wins over also being the default
      ['Cls', true],
      ['I', true],
      ['T', true],
      ['E', true],
      ['helper', true],
      ['internal', true],
    ]);
  });

  it('anonymous and named default exports get a symbol to bind to', () => {
    expect(symbols(`export default function () { return 1; }`)).toEqual([['default', 'function', 'default']]);
    expect(symbols(`export default class Store {}`)).toEqual([['Store', 'class', 'default']]);
    expect(symbols(`export default { a: 1 };`)).toEqual([['default', 'variable', 'default']]);
    expect(facts(`export default function main() {}`).exports).toEqual([{ kind: 'local', name: 'default', local: 'main', typeOnly: false }]);
  });

  it('CommonJS module.exports and exports.x', () => {
    expect(facts(`module.exports = { a };\nexports.b = 1;\nmodule.exports.c = () => {};`, 'javascript').exports.map((e) => e.name)).toEqual([
      'default',
      'b',
      'c',
    ]);
  });
});

describe('symbols', () => {
  it('kinds, class members, and spans that include the export keyword', () => {
    const f = facts(
      [
        'export async function load() {}', // 1
        'const arrow = () => 1;', // 2
        'let a = 1, b = 2;', // 3
        'export class Repo {', // 4
        '  save() { return 1; }', // 5
        '  static create() {}', // 6
        '}', // 7
        'interface Shape {}', // 8
        'declare const VERSION: string;', // 9
        'namespace NS { export const x = 1; }', // 10
        'const { p, q: renamed, ...rest } = obj;', // 11
      ].join('\n'),
    );
    expect(f.symbols.map((s) => [s.name, s.kind, s.span.startLine, s.span.endLine, s.parent ?? null])).toEqual([
      ['load', 'function', 1, 1, null],
      ['arrow', 'function', 2, 2, null],
      ['a', 'variable', 3, 3, null],
      ['b', 'variable', 3, 3, null],
      ['Repo', 'class', 4, 7, null],
      ['Repo.save', 'method', 5, 5, 'Repo'],
      ['Repo.create', 'method', 6, 6, 'Repo'],
      ['Shape', 'interface', 8, 8, null],
      ['VERSION', 'variable', 9, 9, null],
      ['NS', 'variable', 10, 10, null],
      ['p', 'variable', 11, 11, null],
      ['renamed', 'variable', 11, 11, null],
      ['rest', 'variable', 11, 11, null],
    ]);
  });

  it('marks capitalized functions in TSX/JSX as components', () => {
    expect(symbols(`export const Button = () => <button />;\nfunction Card() { return null; }\nfunction helper() {}`, 'tsx')).toEqual([
      ['Button', 'component', true],
      ['Card', 'component', false],
      ['helper', 'function', false],
    ]);
    expect(symbols(`function Card() {}`, 'typescript')).toEqual([['Card', 'function', false]]);
  });

  it('merges overloads into one symbol spanning every signature', () => {
    const [symbol, ...rest] = facts(`function f(a: string): void;\nfunction f(a: number): void;\nfunction f(a: unknown) {}\n`).symbols;
    expect(rest).toEqual([]);
    expect(symbol).toMatchObject({ name: 'f', span: { startLine: 1, endLine: 3 } });
  });
});

describe('bodyHash', () => {
  const hashOf = (src: string, name = 'f') => facts(src).symbols.find((s) => s.name === name)!.bodyHash;

  it('ignores whitespace and comments', () => {
    const base = hashOf(`function f(a: number) { return a + 1; }`);
    expect(hashOf(`function f(a: number) {\n  // explain\n  return a   +   1; /* why */\n}`)).toBe(base);
  });

  it('changes on any token change, including inside strings', () => {
    const base = hashOf(`function f() { return 'a b'; }`);
    expect(hashOf(`function f() { return 'a  b'; }`)).not.toBe(base);
    expect(hashOf(`function f() { return 'a c'; }`)).not.toBe(base);
    expect(hashOf(`function f() { return "a b".trim(); }`)).not.toBe(base);
  });

  it('is independent of the export keyword and of position in the file', () => {
    expect(hashOf(`export function f() { return 1; }`)).toBe(hashOf(`\n\n\nfunction f() { return 1; }`));
  });

  it('collapses JSX text whitespace like JSX does', () => {
    const tsxHash = (src: string) => facts(src, 'tsx').symbols[0]!.bodyHash;
    expect(tsxHash(`const C = () => <p>Hello   world</p>;`)).toBe(tsxHash(`const C = () => <p>\n  Hello world\n</p>;`));
  });
});

describe('references', () => {
  it('records calls, JSX, extends, types and value uses, only for module-scope bindings', () => {
    expect(
      refs(
        `
        import { api, Base, type Props } from './deps';
        import * as ns from './ns';
        function helper() {}
        export function Page(props: Props) {
          const local = () => 1;
          local();
          console.log(api.get(1));
          helper();
          ns.util.run();
          const handler = helper;
          return <Layout><ns.Widget /><div /></Layout>;
        }
        class Thing extends Base {}
        const Layout = (p: Props) => null;
      `,
        'tsx',
      ),
    ).toEqual([
      'Layout -type-> Props',
      'Page -call-> api.get',
      'Page -call-> helper',
      'Page -call-> ns.util.run',
      'Page -jsx-> Layout',
      'Page -jsx-> ns.Widget',
      'Page -reference-> helper',
      'Page -type-> Props',
      'Thing -extends-> Base',
    ]);
  });

  it('resolves this.method() to Class.method and attributes it to the calling method', () => {
    expect(
      refs(`
        export class Repo {
          save() { return this.validate(); }
          validate() { return true; }
          static make() { return new Repo(); }
        }
      `),
    ).toEqual(['Repo.make -call-> Repo', 'Repo.save -call-> Repo.validate']);
  });

  it('attributes top-level code to <module>, and dedupes repeated references', () => {
    expect(refs(`import { init } from './init';\ninit();\ninit();\nexport const ready = init();`)).toEqual([
      '<module> -call-> init',
      'ready -call-> init',
    ]);
  });

  it('records bound names that feed a fully dynamic import', () => {
    expect(refs(`import { pluginName } from './cfg';\nexport const load = () => import(pluginName);`)).toEqual(['load -reference-> pluginName']);
  });

  it('does not report a declaration name as a use of itself', () => {
    expect(refs(`export function a() {}\nexport class B {}\nexport const c = 1;`)).toEqual([]);
  });
});

describe('module side effects', () => {
  it.each([
    ['import x from "y"; export const a = 1;', false],
    ['export function f() { doThings(); }', false],
    ['export const f = () => doThings();', false],
    ['"use strict";\nexport class A { m() { run(); } }', false],
    ['module.exports = { a: 1 };', false],
    ['init();', true],
    ['export const store = createStore();', true],
    ['window.x = 1;', true],
    ['if (process.env.X) { console.log(1); }', true],
    ['export default register(App);', true],
  ])('%s → %s', (source, expected) => {
    expect(facts(source, 'javascript').hasSideEffects).toBe(expected);
  });
});

describe('robustness', () => {
  it('counts parse errors and still extracts what it can', () => {
    const f = facts(`import { a } from './a';\nexport function broken( {\nexport const ok = 1;`);
    expect(f.parseErrors).toBeGreaterThan(0);
    expect(f.imports.map((i) => i.specifier)).toEqual(['./a']);
  });

  it('reports zero errors for valid code in every JS-family language', () => {
    const cases: Array<[JsLikeLanguage, string]> = [
      ['typescript', 'const x = <number>y; export {};'],
      ['tsx', 'export const C = () => <div className="a">{x as number}</div>;'],
      ['javascript', 'export const f = (a) => a?.b ?? 1;'],
      ['jsx', 'export default function App() { return <></>; }'],
    ];
    for (const [language, source] of cases) expect(facts(source, language).parseErrors, language).toBe(0);
  });

  it('isTestFile recognises test naming conventions', () => {
    const adapter = new TypeScriptAdapter('typescript');
    expect(adapter.isTestFile('src/a.test.ts')).toBe(true);
    expect(adapter.isTestFile('src/__tests__/a.ts')).toBe(true);
    expect(adapter.isTestFile('src/testing.ts')).toBe(false);
  });
});

export type { LanguageId };

describe('moduleHash', () => {
  const hash = (src: string) => facts(src).moduleHash;
  const base = `import { a } from './a';\n// setup\ninit();\nexport function f() { return a; }\nexport { a };\n`;

  it('ignores comments, whitespace and symbol bodies', () => {
    expect(hash(`import { a }   from './a';\n\n/* explain */ init();\nexport function f() { return a + 1; }\nexport { a };\n`)).toBe(hash(base));
  });

  it.each([
    ['an import', base.replace("'./a'", "'./b'")],
    ['top-level code', base.replace('init();', 'init(true);')],
    ['an export clause', base.replace('export { a };', 'export { a as b };')],
    ['a directive', `'use strict';\n${base}`],
  ])('changes when %s changes', (_label, changed) => {
    expect(hash(changed)).not.toBe(hash(base));
  });
});

describe('glob imports (Vite import.meta.glob, webpack require.context)', () => {
  it('turns relative globs into dynamic glob imports, skipping negations', () => {
    expect(
      imports(`
        export const pages = import.meta.glob('./pages/**/*.tsx');
        export const many = import.meta.glob(['./a/*.ts', '!./a/skip.ts', './b/{x,y}.ts'], { eager: true });
        export const icons = require.context('./icons/', true, /\\.svg$/);
        export const aliased = import.meta.glob('/src/**/*.ts');
      `),
    ).toEqual([
      { kind: 'dynamic', pattern: './pages/*.tsx', bindings: [], from: 'pages' },
      { kind: 'dynamic', pattern: './a/*.ts', bindings: [], from: 'many' },
      { kind: 'dynamic', pattern: './b/*', bindings: [], from: 'many' },
      { kind: 'dynamic', pattern: './icons/*', bindings: [], from: 'icons' },
      { kind: 'dynamic', bindings: [], from: 'aliased' }, // not relative: fully dynamic, widens to the package
    ]);
  });

  it('simplifyGlob only ever widens', () => {
    expect(simplifyGlob('./x/**/*.ts')).toBe('./x/*.ts');
    expect(simplifyGlob('./x/{a,b}/*.ts')).toBe('./x/*');
    expect(simplifyGlob('./x/[ab].ts')).toBe('./x/*');
    expect(simplifyGlob('./x/file?.ts')).toBe('./x/file*');
  });
});
