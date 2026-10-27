import { Confidence, type Explanation } from '@depwave/core';
import { describe, expect, it } from 'vitest';
import { renderWhy } from './WhyReporter.js';

const ctx = { base: '0123456789abcdef0123456789abcdef01234567', head: 'HEAD', granularity: 'symbol' as const };

describe('renderWhy', () => {
  it('renders the path as sentences with aligned locations and the seed marked', () => {
    const explanation: Explanation = {
      kind: 'impacted',
      target: 'app/a.test.ts',
      heuristic: false,
      cause: { kind: 'changed' },
      steps: [
        { id: 'file:app/a.test.ts', path: 'app/a.test.ts' },
        { id: 'sym:app/a.test.ts#<module>', path: 'app/a.test.ts', symbol: '<module>', relation: 'PART_OF', confidence: Confidence.certain },
        { id: 'sym:app/a.ts#render', path: 'app/a.ts', symbol: 'render', line: 3, relation: 'CALLS', confidence: Confidence.certain },
        { id: 'sym:lib/t.ts#Props', path: 'lib/t.ts', symbol: 'Props', line: 7, relation: 'REFERENCES', confidence: Confidence.certain, typeOnly: true },
      ],
    };
    expect(renderWhy(explanation, ctx)).toMatchInlineSnapshot(`
      "✔ app/a.test.ts is impacted (symbol level, 0123456789ab...HEAD)

          app/a.test.ts
            → runs its top-level code                app/a.test.ts
            → which calls render                     app/a.ts:3
            → which uses the type Props  ◀ changed   lib/t.ts:7

        This is the shortest path; others may exist.
      "
    `);
  });

  it('marks uncertain hops with ~, explains them, and names the triggers behind a seed', () => {
    const text = renderWhy(
      {
        kind: 'impacted',
        target: 'p/loader.test.ts',
        heuristic: true,
        cause: { kind: 'trigger', triggers: [{ kind: 'lockfile', path: 'pnpm-lock.yaml' }] },
        steps: [
          { id: 'file:p/loader.test.ts', path: 'p/loader.test.ts' },
          { id: 'file:p/loader.ts', path: 'p/loader.ts', relation: 'IMPORTS', confidence: Confidence.certain },
          { id: 'file:p/plugin.ts', path: 'p/plugin.ts', relation: 'WILDCARD', confidence: Confidence.heuristic },
        ],
      },
      ctx,
    );
    expect(text).toContain('→ which imports p/loader.ts');
    expect(text).toContain('~ which may load any module of its package via import(expr), including p/plugin.ts  ◀ selected because pnpm-lock.yaml changed');
    expect(text).toContain("~ marks a step depwave can't prove statically");
  });

  it('says plainly when a file is not impacted, or unknown', () => {
    expect(renderWhy({ kind: 'not-impacted', target: 'a.test.ts', changedFiles: ['x.ts', 'y.ts'] }, ctx)).toBe(
      '✘ a.test.ts is not impacted (symbol level, 0123456789ab...HEAD).\n  Nothing it depends on is among the 2 changed file(s).\n',
    );
    expect(renderWhy({ kind: 'unknown', target: 'nope.ts' }, ctx)).toMatch(/^✘ nope\.ts is not a file depwave knows at HEAD/);
  });
});
