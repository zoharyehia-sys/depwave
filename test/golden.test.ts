/**
 * The Phase 1 acceptance test: every fixture scenario, end to end through the real pipeline
 * (git → inventory → Tree-sitter → resolver → graph → impact → test plan), against its golden file-level test set.
 */
import { allTests, WORKTREE, type Explanation, type Revision } from '@depwave/core';
import { AnalysisPipeline, createCli, createPipeline as createRealPipeline, EXIT_CYCLES, type PipelineOptions } from '@depwave/cli';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { applyChanges, loadFixtures, symbolExpectation, type Fixture, type Scenario } from './support/fixtures.js';
import { TempRepo } from './support/tempRepo.js';

const fixtures = await loadFixtures();
const repos: TempRepo[] = [];
const pipelines: AnalysisPipeline[] = [];
/** Tracks pipelines so their SQLite handles close before temp repos are deleted (Windows refuses to delete open files). */
async function createPipeline(dir: string, options?: PipelineOptions): Promise<AnalysisPipeline> {
  const pipeline = await createRealPipeline(dir, options);
  pipelines.push(pipeline);
  return pipeline;
}
afterAll(() => {
  pipelines.forEach((p) => p.deps.cache?.close());
  repos.forEach((r) => r.dispose());
});

/** Fixture at c1, scenario applied on disk; committed as c2 unless `commit` is false. */
function scenarioRepo(fixture: Fixture, scenario: Scenario, commit = true): { repo: TempRepo; base: string; head: Revision } {
  const { repo, commit: base } = TempRepo.from(fixture.files);
  repos.push(repo);
  const after = applyChanges(fixture.files, scenario.changes);
  for (const path of fixture.files.keys()) if (!after.has(path)) repo.remove(path);
  for (const [path, content] of after) if (fixture.files.get(path) !== content) repo.write(path, content);
  return { repo, base, head: commit ? repo.commit(scenario.name) : WORKTREE };
}

describe.each(fixtures)('$name', (fixture) => {
  it.each(fixture.spec.scenarios)('$name: symbol level (cold, then warm from cache)', async (scenario) => {
    const { repo, base, head } = scenarioRepo(fixture, scenario);

    const cold = await (await createPipeline(repo.dir)).impact({ base, head });
    expect(allTests(cold.plan), JSON.stringify(cold.report.seeds)).toEqual(symbolExpectation(scenario).impactedTests);
    expect(cold.report.granularity).toBe('symbol');
    expect(cold.report.unresolved).toEqual([]);
    expect(cold.stats).toMatchObject({ snapshotHits: 0, factsFromCache: 0 });
    expect(cold.stats.filesParsed).toBeGreaterThan(0);

    // A fresh process (new pipeline, same .depwave/cache.db): both commits come from L3, the diff's facts from L1.
    const warm = await (await createPipeline(repo.dir)).impact({ base, head });
    expect(warm.stats).toMatchObject({ snapshotHits: 2, filesParsed: 0 });
    expect(warm.plan).toEqual(cold.plan);
    expect(warm.report).toEqual(cold.report);
  });

  it.each(fixture.spec.scenarios)('$name: file level', async (scenario) => {
    const { repo, base, head } = scenarioRepo(fixture, scenario);
    const { plan, report } = await (await createPipeline(repo.dir, { granularity: 'file' })).impact({ base, head });
    expect(allTests(plan), JSON.stringify(report.seeds)).toEqual(scenario.expected.file.impactedTests);
    expect(report.granularity).toBe('file');
  });

  it('`depwave cycles` finds exactly the cycles the fixture lists', async () => {
    const { repo } = TempRepo.from(fixture.files);
    repos.push(repo);
    const stdout = new PassThrough();
    const chunks: string[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(c.toString()));
    const code = await createCli().run(['cycles', '--cwd', repo.dir, '--format', 'json', '--no-cache'], { stdout });
    const { cycles } = JSON.parse(chunks.join('')) as { cycles: { files: string[] }[] };
    const expected = fixture.spec.cycles ?? [];
    expect(cycles.map((c) => c.files)).toEqual(expected);
    expect(code).toBe(expected.length > 0 ? EXIT_CYCLES : 0);
  });
});

describe('cache behaviour', () => {
  const basic = fixtures.find((f) => f.name === 'pnpm-basic')!;
  const leaf = basic.spec.scenarios.find((s) => s.name === 'leaf-body-change')!;

  it('WORKTREE is never snapshotted, but its unchanged files come from L1', async () => {
    const { repo, base, head } = scenarioRepo(basic, leaf, false);
    await (await createPipeline(repo.dir)).impact({ base, head });
    const warm = await (await createPipeline(repo.dir)).impact({ base, head });
    expect(warm.stats.snapshotHits).toBe(1); // the base commit
    expect(warm.stats.filesParsed).toBe(0); // the dirty file's facts were stored by content hash on the first run
    expect(warm.stats.factsFromCache).toBeGreaterThan(0);
    expect(allTests(warm.plan)).toEqual(leaf.expected.file.impactedTests);
  });

  it('the cache directory never shows up as a change', async () => {
    const { repo, base, head } = scenarioRepo(basic, leaf);
    await (await createPipeline(repo.dir)).impact({ base, head });
    expect(repo.git('status', '--porcelain')).toBe('');
  });

  it('a cache that throws on every call never changes the answer: the run continues uncached with a warning', async () => {
    const { repo, base, head } = scenarioRepo(basic, leaf);
    const real = await createPipeline(repo.dir, { cache: false });
    const broken = new Proxy({} as NonNullable<AnalysisPipeline['deps']['cache']>, {
      get: () => () => {
        throw new Error('disk full');
      },
    });
    const result = await new AnalysisPipeline({ ...real.deps, cache: broken }).impact({ base, head });
    expect(allTests(result.plan)).toEqual(leaf.expected.file.impactedTests);
    expect(result.stats.cacheWarning).toBe('cache disabled for this run: disk full');
  });

  it('--no-cache leaves no cache behind', async () => {
    const { repo, base, head } = scenarioRepo(basic, leaf);
    await (await createPipeline(repo.dir, { cache: false })).impact({ base, head });
    expect(existsSync(join(repo.dir, '.depwave'))).toBe(false);
  });
});

describe('end-to-end details', () => {
  const basic = fixtures.find((f) => f.name === 'pnpm-basic')!;
  const scenario = (name: string) => basic.spec.scenarios.find((s) => s.name === name)!;

  it('analyzes uncommitted work (head = WORKTREE)', async () => {
    const { repo, base, head } = scenarioRepo(basic, scenario('leaf-body-change'), false);
    const { plan } = await (await createPipeline(repo.dir)).impact({ base, head });
    expect(allTests(plan)).toEqual(scenario('leaf-body-change').expected.file.impactedTests);
  });

  it('compares against the merge base, not the tip of the base branch', async () => {
    const { repo, base } = scenarioRepo(basic, scenario('unrelated-app-change'));
    // main moves on after the branch point with an unrelated money.ts edit: it must not show up in the branch's impact.
    repo.git('checkout', '-q', '-b', 'feature');
    repo.git('checkout', '-q', 'main');
    repo.git('reset', '-q', '--hard', base);
    repo.write('packages/utils/src/money.ts', basic.files.get('packages/utils/src/money.ts')!.replace("'en-US'", "'fr-FR'"));
    repo.commit('main moves on');
    const { plan, report } = await (await createPipeline(repo.dir)).impact({ base: 'main', head: 'feature' });
    expect(report.base).toBe(base);
    expect(allTests(plan)).toEqual(['packages/app/src/about.test.ts']);
  });

  it('file level: explains every impacted test with a shortest path back to a changed file', async () => {
    const { repo, base, head } = scenarioRepo(basic, scenario('leaf-body-change'));
    const { report } = await (await createPipeline(repo.dir, { granularity: 'file' })).impact({ base, head });
    const byId = new Map(report.impacted.map((n) => [n.id, n]));
    const pathTo = (id: string): string[] => {
      const node = byId.get(id)!;
      return node.via === undefined ? [id] : [...pathTo(node.via), id];
    };
    expect(pathTo('file:packages/app/src/checkout.test.ts')).toEqual([
      'file:packages/utils/src/money.ts',
      'file:packages/utils/src/index.ts',
      'file:packages/ui/src/PriceTag.ts',
      'file:packages/ui/src/index.ts',
      'file:packages/app/src/checkout.ts',
      'file:packages/app/src/checkout.test.ts',
    ]);
  });

  it('symbol level: the path goes symbol to symbol, straight through both barrels', async () => {
    const { repo, base, head } = scenarioRepo(basic, scenario('leaf-body-change'));
    const { report } = await (await createPipeline(repo.dir)).impact({ base, head });
    const byId = new Map(report.impacted.map((n) => [n.id, n]));
    const pathTo = (id: string): string[] => {
      const node = byId.get(id)!;
      return node.via === undefined ? [id] : [...pathTo(node.via), id];
    };
    expect(report.seeds).toEqual(['sym:packages/utils/src/money.ts#formatCurrency']);
    expect(pathTo('file:packages/app/src/checkout.test.ts')).toEqual([
      'sym:packages/utils/src/money.ts#formatCurrency',
      'sym:packages/ui/src/PriceTag.ts#PriceTag', // calls formatCurrency (imported via the utils barrel)
      'sym:packages/app/src/checkout.ts#renderCheckout', // calls PriceTag (imported via the ui barrel)
      'sym:packages/app/src/checkout.test.ts#<module>', // the test's top-level code calls renderCheckout
      'file:packages/app/src/checkout.test.ts',
    ]);
  });

  it('runs from the CLI: `depwave impact --cwd <repo> --format json`', async () => {
    const { repo, base, head } = scenarioRepo(basic, scenario('leaf-body-change'));
    const stdout = new PassThrough();
    const chunks: string[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(c.toString()));
    const code = await createCli().run(['impact', '--cwd', repo.dir, '--base', base, '--head', head, '--format', 'json'], { stdout });
    expect(code).toBe(0);
    const { plan } = JSON.parse(chunks.join('')) as { plan: Parameters<typeof allTests>[0] };
    expect(allTests(plan)).toEqual(scenario('leaf-body-change').expected.file.impactedTests);
  });
});

describe('depwave why (end to end)', () => {
  async function why(args: string[]): Promise<{ code: number; json: { explanation: Explanation } }> {
    const stdout = new PassThrough();
    const chunks: string[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(c.toString()));
    const code = await createCli().run(['why', ...args, '--format', 'json', '--no-cache'], { stdout });
    return { code, json: JSON.parse(chunks.join('')) as { explanation: Explanation } };
  }
  const fixture = (name: string) => fixtures.find((f) => f.name === name)!;
  const scenarioOf = (f: Fixture, name: string) => f.spec.scenarios.find((s) => s.name === name)!;

  it('explains a code change, symbol by symbol, through the barrels', async () => {
    const basic = fixture('pnpm-basic');
    const { repo, base, head } = scenarioRepo(basic, scenarioOf(basic, 'leaf-body-change'));
    const { code, json } = await why(['packages/app/src/checkout.test.ts', '--cwd', repo.dir, '--base', base, '--head', head]);
    expect(code).toBe(0);
    expect(json.explanation).toMatchObject({ kind: 'impacted', cause: { kind: 'changed' }, heuristic: false });
    const steps = json.explanation.kind === 'impacted' ? json.explanation.steps : [];
    expect(steps.map((s) => [s.symbol ?? s.path, s.relation ?? '-'])).toEqual([
      ['packages/app/src/checkout.test.ts', '-'],
      ['<module>', 'PART_OF'],
      ['renderCheckout', 'CALLS'],
      ['PriceTag', 'CALLS'],
      ['formatCurrency', 'CALLS'],
    ]);
  });

  it('attributes a trigger-driven selection to the trigger, not to code', async () => {
    const basic = fixture('pnpm-basic');
    const { repo, base, head } = scenarioRepo(basic, scenarioOf(basic, 'manifest-dependency-change'));
    const { json } = await why(['packages/app/src/about.test.ts', '--cwd', repo.dir, '--base', base, '--head', head]);
    expect(json.explanation).toMatchObject({ kind: 'impacted', cause: { kind: 'trigger', triggers: [{ path: 'packages/utils/package.json' }] } });
  });

  it('flags a path through import(expr) widening as heuristic', async () => {
    const dyn = fixture('dynamic-imports');
    const { repo, base, head } = scenarioRepo(dyn, scenarioOf(dyn, 'wildcard-widening'));
    const { json } = await why(['packages/plugins/src/registry.test.ts', '--cwd', repo.dir, '--base', base, '--head', head]);
    expect(json.explanation).toMatchObject({ kind: 'impacted', heuristic: true });
    expect(json.explanation.kind === 'impacted' && json.explanation.steps.some((s) => s.relation === 'WILDCARD')).toBe(true);
  });

  it('says "not impacted" for an unrelated test, and accepts a path relative to a subdirectory', async () => {
    const basic = fixture('pnpm-basic');
    const { repo, base, head } = scenarioRepo(basic, scenarioOf(basic, 'leaf-body-change'));
    const { code, json } = await why(['src/about.test.ts', '--cwd', join(repo.dir, 'packages', 'app'), '--base', base, '--head', head]);
    expect(code).toBe(0);
    expect(json.explanation).toEqual({ kind: 'not-impacted', target: 'packages/app/src/about.test.ts', changedFiles: ['packages/utils/src/money.ts'] });
  });
});

describe('impact --format markdown (end to end)', () => {
  it('produces the PR comment: headline, per-package tests, changed tag, and why-paths for indirectly impacted tests', async () => {
    const basic = fixtures.find((f) => f.name === 'pnpm-basic')!;
    const leaf = basic.spec.scenarios.find((s) => s.name === 'leaf-body-change')!;
    const { repo, base, head } = scenarioRepo(basic, leaf);
    // Also really change the money test (a comment alone wouldn't count: Phase 2 ignores comment-only edits).
    repo.write('packages/utils/src/money.test.ts', `${basic.files.get('packages/utils/src/money.test.ts')!}it('rounds', () => expect(formatCurrency(1.005)).toBeTruthy());\n`);
    const head2 = repo.commit('touch test');

    const stdout = new PassThrough();
    const chunks: string[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(c.toString()));
    const code = await createCli().run(['impact', '--cwd', repo.dir, '--base', base, '--head', head2, '--format', 'markdown', '--no-cache'], { stdout });
    const md = chunks.join('');

    expect(code).toBe(0);
    expect(md).toMatch(/^<!-- depwave-impact -->\n### 🌊 depwave: 3 test files impacted of 5 \(40% skipped\)/);
    expect(md).toContain('- `packages/utils/src/money.test.ts` _(changed in this PR)_');
    expect(md).toContain('#### Why? (top 2 tests)'); // the changed test needs no explanation
    expect(md).toContain('<summary><code>packages/app/src/checkout.test.ts</code></summary>');
    expect(md).toContain('→ which calls formatCurrency  ◀ changed');
    expect(md).not.toContain('<summary><code>packages/utils/src/money.test.ts</code></summary>');
    void head;
  });
});

describe('soundness regressions (end to end)', () => {
  /** Base commit from `files`, head commit with `changes` applied; returns the selected test files. */
  async function selected(files: Record<string, string>, changes: Record<string, string>): Promise<string[]> {
    const { repo, commit: base } = TempRepo.from(new Map(Object.entries(files)));
    repos.push(repo);
    for (const [path, content] of Object.entries(changes)) repo.write(path, content);
    const head = repo.commit('change');
    const { plan } = await (await createPipeline(repo.dir, { cache: false })).impact({ base, head });
    return allTests(plan);
  }

  // As .tsx, `<any>helper()` is a JSX element: no symbol `v`, no call to helper. Facts are per (content, language),
  // so the .ts copy must keep its own, whichever of the two is parsed last.
  it.each(['src/b.tsx', 'src/0.tsx'])('identical bytes in a .ts file and %s keep their own parse', async (tsxPath) => {
    const same = "import { helper } from './helper';\nexport const v = <any>helper();\n";
    const tests = await selected(
      {
        'package.json': '{ "name": "same-bytes", "private": true }\n',
        'src/helper.ts': 'export function helper() {\n  return 1;\n}\n',
        'src/a.ts': same,
        [tsxPath]: same,
        'src/a.test.ts': "import { v } from './a';\nit('v', () => expect(v).toBe(1));\n",
      },
      { 'src/helper.ts': 'export function helper() {\n  return 2;\n}\n' },
    );
    expect(tests).toEqual(['src/a.test.ts']);
  });

  // Which branch of a conditional export runs depends on the runtime (a TS `import` compiled to CommonJS takes
  // `require`), so a test depends on every implementation its specifier can load.
  it.each([
    ['packages/lib/cjs.cjs', 'exports.x = 2;\n'],
    ['packages/lib/esm.mjs', 'export const x = 2;\n'],
  ])('a conditional export reaches the test through %s', async (changed, content) => {
    const tests = await selected(
      {
        'package.json': '{ "name": "root", "private": true }\n',
        'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
        'packages/lib/package.json': JSON.stringify({ name: '@acme/lib', exports: { '.': { import: './esm.mjs', require: './cjs.cjs' } } }),
        'packages/lib/esm.mjs': 'export const x = 1;\n',
        'packages/lib/cjs.cjs': 'exports.x = 1;\n',
        'packages/app/package.json': JSON.stringify({ name: 'app', dependencies: { '@acme/lib': 'workspace:*' } }),
        'packages/app/src/lib.test.js': "const lib = require('@acme/lib');\nit('x', () => expect(lib.x).toBe(1));\n",
      },
      { [changed]: content },
    );
    expect(tests).toEqual(['packages/app/src/lib.test.js']);
  });
});
