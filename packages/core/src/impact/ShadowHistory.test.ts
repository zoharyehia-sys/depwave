import { describe, expect, it } from 'vitest';
import type { ShadowResult } from '../model/shadow.js';
import { aggregateShadow, recallLowerBound, type ShadowRecord } from './ShadowHistory.js';

const shadow = (overrides: Partial<ShadowResult>): ShadowResult => ({
  verdict: 'sound',
  runAll: false,
  basis: { selectionTested: true, complete: true },
  selected: 10,
  ran: 40,
  partial: false,
  totalTests: 40,
  notRun: [],
  failed: [],
  caught: [],
  missed: [],
  unrecognized: [],
  unattributedFailures: 0,
  ...overrides,
});
const record = (head: string, overrides: Partial<ShadowResult> = {}, granularity = 'symbol'): ShadowRecord => ({
  base: 'b0',
  head,
  granularity,
  shadow: shadow(overrides),
});

describe('recallLowerBound', () => {
  it('with no miss is (1 - confidence)^(1/n): 99.9% at 95% takes 2,995 failures', () => {
    expect(recallLowerBound(10, 10, 0.95)).toBeCloseTo(0.05 ** (1 / 10), 9);
    expect(recallLowerBound(2995, 2995, 0.95)).toBeGreaterThanOrEqual(0.999);
    expect(recallLowerBound(2994, 2994, 0.95)).toBeLessThan(0.999);
  });

  it('matches the exact Clopper-Pearson bound with misses', () => {
    // P(X >= 9 | n = 10, p) = 0.05 at p = 0.6058.
    expect(recallLowerBound(9, 10, 0.95)).toBeCloseTo(0.6058, 3);
    expect(recallLowerBound(0, 5, 0.95)).toBe(0);
  });
});

describe('aggregateShadow', () => {
  it('counts recall only over runs that tested the selection: run-all failures would inflate it', () => {
    const history = aggregateShadow([
      record('h1', { failed: ['a.test.ts', 'b.test.ts'], caught: ['a.test.ts'], missed: ['b.test.ts'], verdict: 'missed' }),
      record('h2', { runAll: true, basis: { selectionTested: false, complete: true }, failed: ['c.test.ts'], caught: ['c.test.ts'] }),
      record('h3', { failed: ['d.test.ts'], caught: ['d.test.ts'] }),
    ]);
    expect(history).toMatchObject({ runs: 3, selectionRuns: 2, runAllRuns: 1, failures: 3, caught: 2, recall: 2 / 3 });
    expect(history.missed).toEqual([{ base: 'b0', head: 'h1', path: 'b.test.ts', discovery: false }]);
  });

  it('merges the same commit tested on several OSes into one run, failures as a union', () => {
    const history = aggregateShadow([
      record('h1', { failed: ['a.test.ts'], caught: ['a.test.ts'], unattributedFailures: 1 }),
      record('h1', { failed: ['a.test.ts', 'win.test.ts'], caught: ['a.test.ts', 'win.test.ts'], unattributedFailures: 1, basis: { selectionTested: true, complete: false } }),
    ]);
    expect(history).toMatchObject({ records: 2, runs: 1, failures: 2, caught: 2, unattributedFailures: 1, incompleteRuns: 1 });
  });

  it('keeps granularities apart, and marks misses of files depwave never sees as tests', () => {
    const history = aggregateShadow([
      record('h1', { failed: ['e2e/x.ts'], missed: ['e2e/x.ts'], unrecognized: ['e2e/x.ts'], verdict: 'missed' }),
      record('h1', { failed: ['e2e/x.ts'], missed: ['e2e/x.ts'], unrecognized: ['e2e/x.ts'], verdict: 'missed' }, 'file'),
    ]);
    expect(history.runs).toBe(2);
    expect(history.missed).toEqual([
      { base: 'b0', head: 'h1', path: 'e2e/x.ts', discovery: true },
      { base: 'b0', head: 'h1', path: 'e2e/x.ts', discovery: true },
    ]);
  });

  it('says how many more caught failures the evidence needs, and averages savings with run-all runs as 0', () => {
    const history = aggregateShadow([
      record('h1', { failed: ['a.test.ts'], caught: ['a.test.ts'], selected: 10, totalTests: 40 }),
      record('h2', { runAll: true, basis: { selectionTested: false, complete: true } }),
    ]);
    expect(history.recallLowerBound).toBeCloseTo(0.05, 9);
    expect(history.failuresNeeded).toBe(2994);
    expect(history.averageSkipped).toBeCloseTo(0.375, 9); // (0.75 + 0) / 2
  });

  it('has no recall before a failure is observed', () => {
    const history = aggregateShadow([record('h1')]);
    expect(history).toMatchObject({ failures: 0, recall: undefined, recallLowerBound: undefined, failuresNeeded: 2995 });
    expect(aggregateShadow([]).averageSkipped).toBeUndefined();
  });
});
