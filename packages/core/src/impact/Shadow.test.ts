import { describe, expect, it } from 'vitest';
import type { TestPlan } from '../model/impact.js';
import type { TestFileOutcome } from '../model/shadow.js';
import { compareShadow } from './Shadow.js';

const plan = (tests: string[], runAll = false): TestPlan => ({ runAll, groups: [{ packageName: 'p', runner: 'vitest', tests }] });
const run = (outcomes: TestFileOutcome[], unattributedFailures = 0) => ({ outcomes, unattributedFailures });
const isTest = (p: string) => p.endsWith('.test.ts');

describe('compareShadow', () => {
  it('is sound when every failing test was selected', () => {
    const result = compareShadow(plan(['a.test.ts']), run([{ path: 'a.test.ts', status: 'failed' }, { path: 'b.test.ts', status: 'passed' }]), isTest);
    expect(result).toMatchObject({ verdict: 'sound', selected: 1, ran: 2, failed: ['a.test.ts'], caught: ['a.test.ts'], missed: [] });
  });

  it('reports a failing test that was not selected as a miss', () => {
    const result = compareShadow(plan(['a.test.ts']), run([{ path: 'a.test.ts', status: 'passed' }, { path: 'b.test.ts', status: 'failed' }]), isTest);
    expect(result).toMatchObject({ verdict: 'missed', caught: [], missed: ['b.test.ts'] });
  });

  it('merges a file that appears several times: any failure wins (retries, several result files)', () => {
    const result = compareShadow(
      plan([]),
      run([{ path: 'b.test.ts', status: 'failed' }, { path: 'b.test.ts', status: 'passed' }, { path: 'c.test.ts', status: 'skipped' }]),
      isTest,
    );
    expect(result).toMatchObject({ verdict: 'missed', ran: 2, missed: ['b.test.ts'] });
  });

  it('cannot miss anything when a global trigger selected every test', () => {
    const result = compareShadow(plan([], true), run([{ path: 'b.test.ts', status: 'failed' }], 2), isTest);
    expect(result).toMatchObject({ verdict: 'sound', runAll: true, caught: ['b.test.ts'], missed: [] });
  });

  it('is inconclusive, not sound, when failures could not be traced to a file', () => {
    expect(compareShadow(plan(['a.test.ts']), run([], 1), isTest).verdict).toBe('inconclusive');
  });

  it('lists result files depwave does not classify as tests (a discovery gap), failing or not', () => {
    const result = compareShadow(plan([]), run([{ path: 'spec/x.spec.js', status: 'failed' }, { path: 'e2e/y.ts', status: 'passed' }]), isTest);
    expect(result.unrecognized).toEqual(['e2e/y.ts', 'spec/x.spec.js']);
    expect(result.missed).toEqual(['spec/x.spec.js']);
  });
});
