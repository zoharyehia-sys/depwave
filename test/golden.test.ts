/**
 * The Phase 1 acceptance test: every fixture scenario, end to end through the real pipeline
 * (git → inventory → Tree-sitter → resolver → graph → impact → test plan), against its golden file-level test set.
 */
import { allTests, WORKTREE, type Revision } from '@depwave/core';
import { createCli, createPipeline } from '@depwave/cli';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { applyChanges, loadFixtures, type Fixture, type Scenario } from './support/fixtures.js';
import { TempRepo } from './support/tempRepo.js';

const fixtures = await loadFixtures();
const repos: TempRepo[] = [];
afterAll(() => repos.forEach((r) => r.dispose()));

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
  it.each(fixture.spec.scenarios)('$name', async (scenario) => {
    const { repo, base, head } = scenarioRepo(fixture, scenario);
    const { plan, report } = await createPipeline(repo.dir).impact({ base, head });
    expect(allTests(plan), JSON.stringify(report.seeds)).toEqual(scenario.expected.file.impactedTests);
    expect(report.unresolved).toEqual([]);
  });
});

describe('end-to-end details', () => {
  const basic = fixtures.find((f) => f.name === 'pnpm-basic')!;
  const scenario = (name: string) => basic.spec.scenarios.find((s) => s.name === name)!;

  it('analyzes uncommitted work (head = WORKTREE)', async () => {
    const { repo, base, head } = scenarioRepo(basic, scenario('leaf-body-change'), false);
    const { plan } = await createPipeline(repo.dir).impact({ base, head });
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
    const { plan, report } = await createPipeline(repo.dir).impact({ base: 'main', head: 'feature' });
    expect(report.base).toBe(base);
    expect(allTests(plan)).toEqual(['packages/app/src/about.test.ts']);
  });

  it('explains every impacted test with a shortest path back to a changed file', async () => {
    const { repo, base, head } = scenarioRepo(basic, scenario('leaf-body-change'));
    const { report } = await createPipeline(repo.dir).impact({ base, head });
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
