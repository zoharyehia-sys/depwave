/**
 * Every fixture file through the real ASTParser, with golden facts for the files each fixture exists to exercise.
 */
import { languageFromPath, type FileFacts } from '@depwave/core';
import { describe, expect, it } from 'vitest';
import { isTestFile, loadFixtures } from '../../../test/support/fixtures.js';
import { ASTParser, PARSER_VERSION } from './ASTParser.js';
import { LanguageRegistry } from './LanguageRegistry.js';
import { TypeScriptAdapter } from './languages/typescript/TypeScriptAdapter.js';
import type { TreeSitterLanguageAdapter } from './treeSitter.js';

const fixtures = await loadFixtures();
const parser = new ASTParser();

async function parseFixture(name: string): Promise<Map<string, FileFacts>> {
  const fixture = fixtures.find((f) => f.name === name)!;
  const inputs = [...fixture.files]
    .filter(([path]) => parser.supports(path))
    .map(([path, content]) => ({ path, content, language: languageFromPath(path)!, contentHash: `hash:${path}` }));
  const out = new Map<string, FileFacts>();
  for await (const facts of parser.extract(inputs)) out.set(facts.path, facts);
  return out;
}

const parsed = new Map(await Promise.all(fixtures.map(async (f) => [f.name, await parseFixture(f.name)] as const)));
const get = (fixture: string, path: string) => {
  const facts = parsed.get(fixture)?.get(path);
  if (!facts) throw new Error(`no facts for ${fixture}/${path}`);
  return facts;
};
const specifiers = (f: FileFacts) => f.imports.map((i) => i.specifier ?? i.pattern ?? '<dynamic>');
const refs = (f: FileFacts) => f.references.map(({ kind, from, to }) => `${from} -${kind}-> ${to}`).sort();

describe('ASTParser over every fixture', () => {
  it('parses every source file without errors and stamps hash + parser version', () => {
    let count = 0;
    for (const [, files] of parsed) {
      for (const [path, facts] of files) {
        expect(facts.parseErrors, path).toBe(0);
        expect(facts.contentHash).toBe(`hash:${path}`);
        expect(facts.parserVersion).toBe(PARSER_VERSION);
        count++;
      }
    }
    expect(count).toBe(106); // 12 + 14 + 11 + 13 + 8 (workspace inventory test) + 8 (instance-methods) + 10 (runtime-deps) + 10 × 3 (pnpm/npm/yarn-lockfile)
  });

  it('every test file imports what it tests', () => {
    for (const [, files] of parsed) {
      for (const [path, facts] of files) {
        if (!isTestFile(path)) continue;
        expect(specifiers(facts), path).toContain('vitest');
        // A test either imports what it tests, or reaches it at runtime (spawned process, fs): runtime-deps fixture.
        const runtime = facts.imports.some((i) => ['node:child_process', 'node:fs'].includes(i.specifier ?? ''));
        expect(runtime || facts.imports.some((i) => i.specifier?.startsWith('./')), path).toBe(true);
      }
    }
  });
});

describe('barrel-hell', () => {
  it('index.ts is pure re-exports: star, named, and barrel-of-barrels', () => {
    const index = get('barrel-hell', 'packages/ui/src/index.ts');
    expect(index.exports).toEqual([
      { kind: 'reexport-all', name: '*', from: './Button', typeOnly: false },
      { kind: 'reexport-all', name: '*', from: './Card', typeOnly: false },
      { kind: 'reexport', name: 'Modal', local: 'Modal', from: './Modal', typeOnly: false },
      { kind: 'reexport-all', name: '*', from: './forms', typeOnly: false },
    ]);
    expect(index.symbols).toEqual([]);
    expect(index.hasSideEffects).toBe(false);
  });

  it('Card calls Button through a named import', () => {
    const card = get('barrel-hell', 'packages/ui/src/Card.ts');
    expect(card.imports).toEqual([{ kind: 'static', specifier: './Button', bindings: [{ imported: 'Button', local: 'Button' }], loc: { line: 1, col: 1 } }]);
    expect(card.symbols.map((s) => [s.name, s.kind, s.exported])).toEqual([['Card', 'function', true]]);
    expect(refs(card)).toEqual(['Card -call-> Button']);
  });

  it('home binds two names from the package barrel', () => {
    const home = get('barrel-hell', 'packages/app/src/pages/home.ts');
    expect(home.imports[0]).toMatchObject({ specifier: '@barrel/ui', bindings: [{ imported: 'Button' }, { imported: 'Card' }] });
    expect(refs(home)).toEqual(['renderHome -call-> Button', 'renderHome -call-> Card']);
  });

  it("Modal's comment sits inside the symbol span (so a comment-only edit maps to it)", () => {
    const [modal] = get('barrel-hell', 'packages/ui/src/Modal.ts').symbols;
    expect(modal).toMatchObject({ name: 'Modal', span: { startLine: 1, endLine: 4 } });
  });
});

describe('dynamic-imports', () => {
  it('template-literal import becomes a glob', () => {
    expect(get('dynamic-imports', 'packages/app/src/i18n/load.ts').imports).toEqual([
      { kind: 'dynamic', pattern: './locales/*.ts', bindings: [], from: 'loadMessages', loc: { line: 2, col: 21 } },
    ]);
  });

  it('literal lazy import keeps its specifier', () => {
    expect(specifiers(get('dynamic-imports', 'packages/app/src/routes.ts'))).toEqual(['./pages/Home']);
  });

  it('import(name) is fully dynamic: no specifier, no pattern', () => {
    const [imp] = get('dynamic-imports', 'packages/plugins/src/registry.ts').imports;
    expect(imp).toEqual({ kind: 'dynamic', bindings: [], from: 'loadPlugin', loc: { line: 3, col: 10 } });
  });
});

describe('ts-paths and cycles', () => {
  it('keeps alias specifiers verbatim for the resolver', () => {
    expect(specifiers(get('ts-paths', 'src/features/report.ts'))).toEqual(['@lib/date']);
    expect(specifiers(get('ts-paths', 'src/features/stats.ts'))).toEqual(['~/lib/math']);
    expect(specifiers(get('ts-paths', 'src/features/legacy.ts'))).toEqual(['../utils']);
  });

  it('records the cycle edges a → b → c → a', () => {
    expect(specifiers(get('cycles', 'src/a.ts'))).toEqual(['./b']);
    expect(specifiers(get('cycles', 'src/b.ts'))).toEqual(['./c']);
    expect(specifiers(get('cycles', 'src/c.ts'))).toEqual(['./a']);
    expect(refs(get('cycles', 'src/c.ts'))).toEqual(['c -call-> a']);
  });
});

describe('pnpm-basic', () => {
  it('cross-package import and template-literal JSX-free rendering', () => {
    const priceTag = get('pnpm-basic', 'packages/ui/src/PriceTag.ts');
    expect(specifiers(priceTag)).toEqual(['@basic/utils']);
    expect(refs(priceTag)).toEqual(['PriceTag -call-> formatCurrency']);
  });
});

describe('ASTParser contract', () => {
  it('rejects files no adapter supports', async () => {
    const run = async () => {
      for await (const _ of parser.extract([{ path: 'README.md', content: '', language: 'typescript', contentHash: 'x' }])) {
        // drain
      }
    };
    await expect(run()).rejects.toThrow(/No language adapter for README.md/);
  });

  it('supports the JS family and nothing else', () => {
    expect(['a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cts', 'a.py', 'a.md'].map((p) => parser.supports(p) ?? null)).toEqual([
      'typescript',
      'tsx',
      'javascript',
      'jsx',
      'javascript',
      'typescript',
      null,
      null,
    ]);
  });
});

describe('ASTParser crash isolation', () => {
  it('a file whose extraction throws gets conservative empty facts; the other files are unaffected', async () => {
    const throwing = new TypeScriptAdapter('typescript');
    const original = throwing.extractFacts.bind(throwing);
    throwing.extractFacts = (tree, source, path) => {
      if (path === 'src/generated.ts') throw new RangeError('Maximum call stack size exceeded');
      return original(tree, source, path);
    };
    const isolated = new ASTParser(new LanguageRegistry<TreeSitterLanguageAdapter>().register(throwing));

    const out: FileFacts[] = [];
    const input = (path: string, content: string) => ({ path, content, language: 'typescript' as const, contentHash: `h:${path}` });
    for await (const f of isolated.extract([input('src/generated.ts', 'export const x = 1;'), input('src/ok.ts', "import { y } from './y';")])) out.push(f);

    expect(out[0]).toMatchObject({ path: 'src/generated.ts', failed: 'RangeError: Maximum call stack size exceeded', imports: [], symbols: [], contentHash: 'h:src/generated.ts' });
    expect(out[1]?.failed).toBeUndefined();
    expect(out[1]?.imports.map((i) => i.specifier)).toEqual(['./y']);
  });
});
