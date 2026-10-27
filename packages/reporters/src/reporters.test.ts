import { Confidence, type ImpactReport, type TestPlan } from '@depwave/core';
import { describe, expect, it } from 'vitest';
import { JsonReporter } from './JsonReporter.js';
import { TextReporter } from './TextReporter.js';

const report: ImpactReport = {
  base: '0123456789abcdef0123456789abcdef01234567',
  head: 'HEAD',
  granularity: 'symbol',
  changedFiles: ['packages/utils/src/money.ts'],
  seeds: ['file:packages/utils/src/money.ts'],
  globalTriggers: [],
  impacted: [
    { id: 'file:packages/utils/src/money.ts', distance: 0, confidence: Confidence.certain, score: 1 },
    {
      id: 'file:packages/ui/src/PriceTag.ts',
      distance: 1,
      confidence: Confidence.certain,
      via: 'file:packages/utils/src/money.ts',
      score: 0.85,
    },
  ],
  unresolved: [],
};

const plan: TestPlan = {
  runAll: false,
  groups: [{ packageName: '@basic/ui', runner: 'vitest', tests: ['packages/ui/src/PriceTag.test.ts'] }],
};

describe('TextReporter', () => {
  it('summarizes the run and lists impacted tests per package', () => {
    expect(new TextReporter().render(report, plan)).toMatchInlineSnapshot(`
      "depwave impact 0123456789ab...HEAD (symbol level)
        changed files:  1
        impacted nodes: 2
        impacted tests: 1

      @basic/ui (vitest): 1 test file(s)
        packages/ui/src/PriceTag.test.ts
      "
    `);
  });

  it('names global triggers and warns about unresolved imports', () => {
    const text = new TextReporter().render(
      {
        ...report,
        globalTriggers: [{ kind: 'lockfile', path: 'pnpm-lock.yaml' }],
        unresolved: [{ from: 'src/a.ts', specifier: './gone', reason: 'not-found' }],
      },
      { runAll: true, groups: [] },
    );
    expect(text).toContain('trigger:        pnpm-lock.yaml (lockfile, everything)');
    expect(text).toContain('unresolved imports: 1');
    expect(text).toContain('Run ALL tests');
  });

  it('says so when nothing is impacted', () => {
    expect(new TextReporter().render(report, { runAll: false, groups: [] })).toContain('No impacted tests.');
  });
});

describe('JsonReporter', () => {
  it('emits parseable JSON containing report and plan', () => {
    expect(JSON.parse(new JsonReporter().render(report, plan))).toEqual({ report, plan });
  });
});
