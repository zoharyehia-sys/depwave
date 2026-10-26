import { Confidence, type ImpactReport, type TestPlan } from '@ripple/core';
import { describe, expect, it } from 'vitest';
import { JsonReporter } from './JsonReporter.js';
import { TextReporter } from './TextReporter.js';

const report: ImpactReport = {
  base: 'abc123',
  head: 'HEAD',
  seeds: ['sym:packages/utils/src/money.ts#formatCurrency'],
  impacted: [
    {
      id: 'file:packages/ui/src/PriceTag.ts',
      distance: 1,
      confidence: Confidence.certain,
      via: 'sym:packages/utils/src/money.ts#formatCurrency',
      score: 0.85,
    },
  ],
};

const plan: TestPlan = {
  runAll: false,
  groups: [{ packageName: '@basic/ui', runner: 'vitest', tests: ['packages/ui/src/PriceTag.test.ts'] }],
};

describe('TextReporter', () => {
  it('lists impacted tests per package', () => {
    expect(new TextReporter().render(report, plan)).toMatchInlineSnapshot(`
      "ripple impact abc123...HEAD
        changed:  1 node(s)
        impacted: 1 node(s)

      @basic/ui (vitest): 1 test file(s)
        packages/ui/src/PriceTag.test.ts
      "
    `);
  });

  it('says so when a global trigger forces a full run', () => {
    expect(new TextReporter().render(report, { runAll: true, groups: [] })).toContain('Run ALL tests');
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
