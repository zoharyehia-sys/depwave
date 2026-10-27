import { Confidence, type Explanation, type ImpactReport, type TestPlan } from '@depwave/core';
import { describe, expect, it } from 'vitest';
import { COMMENT_MARKER, MarkdownReporter } from './MarkdownReporter.js';

const report: ImpactReport = {
  base: '0123456789abcdef0123456789abcdef01234567',
  head: 'fedcba9876543210fedcba9876543210fedcba98',
  granularity: 'symbol',
  changedFiles: ['packages/utils/src/money.ts', 'packages/utils/src/money.test.ts'],
  seeds: [],
  globalTriggers: [],
  impacted: [],
  unresolved: [],
};
const plan: TestPlan = {
  runAll: false,
  totalTests: 40,
  groups: [
    { packageName: '@acme/app', runner: 'vitest', tests: ['packages/app/src/checkout.test.ts'] },
    { packageName: '@acme/utils', runner: 'jest', tests: ['packages/utils/src/money.test.ts'] },
  ],
};
const why: Explanation = {
  kind: 'impacted',
  target: 'packages/app/src/checkout.test.ts',
  heuristic: false,
  cause: { kind: 'changed' },
  steps: [
    { id: 'file:packages/app/src/checkout.test.ts', path: 'packages/app/src/checkout.test.ts' },
    { id: 'sym:packages/utils/src/money.ts#formatCurrency', path: 'packages/utils/src/money.ts', symbol: 'formatCurrency', line: 1, relation: 'CALLS', confidence: Confidence.certain },
  ],
};

describe('MarkdownReporter', () => {
  it('leads with the headline and savings, lists tests per package, marks changed tests, and explains the top ones', () => {
    const md = new MarkdownReporter([why]).render(report, plan);
    expect(md.startsWith(`${COMMENT_MARKER}\n### 🌊 depwave: 2 test files impacted of 40 (95% skipped)\n`)).toBe(true);
    expect(md).toContain('| Compared | `0123456` (merge base) → `fedcba9` |');
    expect(md).toContain('| Impacted tests | **2** of 40 |');
    expect(md).toContain('<details><summary><b>@acme/utils</b> (jest): 1 file</summary>');
    expect(md).toContain('- `packages/utils/src/money.test.ts` _(changed in this PR)_');
    expect(md).toContain('- `packages/app/src/checkout.test.ts`\n');
    expect(md).toContain('#### Why? (top 1 test)');
    expect(md).toContain('→ which calls formatCurrency  ◀ changed');
    expect(md).toContain('`depwave why <test> --base 0123456`'); // literal <test>, not &lt;test&gt;, inside a code span
  });

  it('says so when nothing is impacted', () => {
    const md = new MarkdownReporter().render(report, { runAll: false, groups: [], totalTests: 40 });
    expect(md).toContain('### 🌊 depwave: no test files impacted ✅');
    expect(md).not.toContain('#### Tests to run');
    expect(md).not.toContain('#### Why?');
  });

  it('explains a full run by its trigger', () => {
    const md = new MarkdownReporter().render(
      { ...report, globalTriggers: [{ kind: 'lockfile', path: 'pnpm-lock.yaml' }] },
      { ...plan, runAll: true },
    );
    expect(md).toContain('### 🌊 depwave: all 40 test files (a global trigger fired)');
    expect(md).toContain('> [!NOTE]\n> `pnpm-lock.yaml` changed (lockfile): every test runs.');
  });

  it('warns about unresolved imports, capped at 10 lines', () => {
    const unresolved = Array.from({ length: 12 }, (_, i) => ({ from: `src/f${i}.ts`, specifier: './gone', reason: 'not-found' }));
    const md = new MarkdownReporter().render({ ...report, unresolved }, plan);
    expect(md).toContain('> [!WARNING]\n> 12 imports could not be resolved');
    expect(md).toContain('> - … and 2 more');
    expect(md.match(/^> - `src\/f/gm)).toHaveLength(10);
  });

  it('escapes HTML in package names used inside <summary>', () => {
    const md = new MarkdownReporter().render(report, { ...plan, groups: [{ packageName: '<script>', runner: 'unknown', tests: ['a.test.ts'] }] });
    expect(md).toContain('<b>&lt;script&gt;</b>');
  });
});
