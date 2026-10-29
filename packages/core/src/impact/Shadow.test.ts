import { describe, expect, it } from 'vitest';
import type { TestPlan } from '../model/impact.js';
import type { TestFileOutcome } from '../model/shadow.js';
import { compareShadow } from './Shadow.js';

const plan = (tests: string[], runAll = false): TestPlan => ({ runAll, groups: [{ packageName: 'p', runner: 'vitest', tests }] });
const run = (outcomes: TestFileOutcome[], unattributedFailures = 0) => ({ outcomes, unattributedFailures });
const tests = (...paths: string[]) => new Set(paths);
const passed = (...paths: string[]): TestFileOutcome[] => paths.map((path) => ({ path, status: 'passed' }));

describe('compareShadow', () => {
  it('is sound when every test file has a result and every failing one was selected', () => {
    const result = compareShadow(plan(['a.test.ts']), run([{ path: 'a.test.ts', status: 'failed' }, ...passed('b.test.ts')]), tests('a.test.ts', 'b.test.ts'));
    expect(result).toMatchObject({ verdict: 'sound', selected: 1, ran: 2, partial: false, notRun: [], totalTests: 2, failed: ['a.test.ts'], caught: ['a.test.ts'], missed: [] });
  });

  it('is inconclusive, never sound, when unselected test files have no result: a failure there would go unchecked', () => {
    // The review's case: 100 test files, 5 selected, results for just those 5. Nothing failed, but 95 were never seen.
    const all = Array.from({ length: 100 }, (_, i) => `t${String(i).padStart(3, '0')}.test.ts`);
    const selected = all.slice(0, 5);
    const result = compareShadow(plan(selected), run(passed(...selected)), new Set(all));
    expect(result).toMatchObject({ verdict: 'inconclusive', partial: true, totalTests: 100, ran: 5 });
    expect(result.notRun).toEqual(all.slice(5));
  });

  it('is inconclusive when a selected test file has no result, or the results name no known test at all', () => {
    expect(compareShadow(plan(['a.test.ts', 'b.test.ts']), run(passed('a.test.ts')), tests('a.test.ts', 'b.test.ts'))).toMatchObject({ verdict: 'inconclusive', notRun: ['b.test.ts'] });
    expect(compareShadow(plan([]), run(passed('e2e/y.ts')), tests('a.test.ts'))).toMatchObject({ verdict: 'inconclusive', ran: 1, notRun: ['a.test.ts'], unrecognized: ['e2e/y.ts'] });
  });

  it('a miss is a miss even when results are incomplete', () => {
    const result = compareShadow(plan(['a.test.ts']), run([{ path: 'b.test.ts', status: 'failed' }]), tests('a.test.ts', 'b.test.ts', 'c.test.ts'));
    expect(result).toMatchObject({ verdict: 'missed', missed: ['b.test.ts'], partial: true, notRun: ['a.test.ts', 'c.test.ts'] });
  });

  it('counts skipped results as present (the runner saw the file), and merges repeats: any failure wins', () => {
    const result = compareShadow(
      plan([]),
      run([{ path: 'b.test.ts', status: 'failed' }, { path: 'b.test.ts', status: 'passed' }, { path: 'c.test.ts', status: 'skipped' }]),
      tests('b.test.ts', 'c.test.ts'),
    );
    expect(result).toMatchObject({ verdict: 'missed', ran: 2, missed: ['b.test.ts'], partial: false });
  });

  it('cannot miss anything when a global trigger selected every test, so incomplete results are fine', () => {
    const result = compareShadow(plan([], true), run([{ path: 'b.test.ts', status: 'failed' }], 2), tests('b.test.ts', 'c.test.ts'));
    expect(result).toMatchObject({ verdict: 'sound', runAll: true, caught: ['b.test.ts'], missed: [], partial: true });
  });

  it('is inconclusive, not sound, when failures could not be traced to a file', () => {
    expect(compareShadow(plan(['a.test.ts']), run(passed('a.test.ts'), 1), tests('a.test.ts')).verdict).toBe('inconclusive');
  });

  it('lists result files depwave does not classify as tests (a discovery gap), failing or not', () => {
    const result = compareShadow(plan([]), run([{ path: 'spec/x.spec.js', status: 'failed' }, ...passed('e2e/y.ts')]), tests());
    expect(result.unrecognized).toEqual(['e2e/y.ts', 'spec/x.spec.js']);
    expect(result.missed).toEqual(['spec/x.spec.js']);
  });
});
