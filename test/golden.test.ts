/**
 * The Phase 1 acceptance test: every fixture scenario, end to end through the real pipeline
 * (git → inventory → Tree-sitter → resolver → graph → impact → test plan), against its golden file-level test set.
 */
import { allTests, WORKTREE, type Revision } from '@depwave/core';
import { AnalysisPipeline, createCli, createPipeline as createRealPipeline, type PipelineOptions } from '@depwave/cli';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { applyChanges, loadFixtures, type Fixture, type Scenario } from './support/fixtures.js';
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
  it.each(fixture.spec.scenarios)('$name (cold, then warm from cache)', async (scenario) => {
    const { repo, base, head } = scenarioRepo(fixture, scenario);

    const cold = await (await createPipeline(repo.dir)).impact({ base, head });
    expect(allTests(cold.plan), JSON.stringify(cold.report.seeds)).toEqual(scenario.expected.file.impactedTests);
    expect(cold.report.unresolved).toEqual([]);
    expect(cold.stats).toMatchObject({ snapshotHits: 0, factsFromCache: 0 });
    expect(cold.stats.filesParsed).toBeGreaterThan(0);

    // A fresh process (new pipeline, same .depwave/cache.db): both commits come straight from L3.
    const warm = await (await createPipeline(repo.dir)).impact({ base, head });
    expect(warm.stats).toEqual({ snapshotHits: 2, factsFromCache: 0, filesParsed: 0 });
    expect(warm.plan).toEqual(cold.plan);
    expect(warm.report).toEqual(cold.report);
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

  it('explains every impacted test with a shortest path back to a changed file', async () => {
    const { repo, base, head } = scenarioRepo(basic, scenario('leaf-body-change'));
    const { report } = await (await createPipeline(repo.dir)).impact({ base, head });
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
