import type { ShadowResult } from '@depwave/core';
import { describe, expect, it } from 'vitest';
import { renderShadowMarkdown, renderShadowText } from './ShadowReporter.js';

const ctx = { base: '0123456789abcdef0123456789abcdef01234567', head: 'HEAD' };
const result = (overrides: Partial<ShadowResult>): ShadowResult => ({
  verdict: 'sound',
  runAll: false,
  selected: 3,
  ran: 40,
  failed: [],
  caught: [],
  missed: [],
  unrecognized: [],
  unattributedFailures: 0,
  ...overrides,
});

describe('shadow reporters', () => {
  it('text: headline with the savings, and every miss on its own line', () => {
    const text = renderShadowText(result({ verdict: 'missed', failed: ['a.test.ts', 'e2e/b.ts'], missed: ['a.test.ts', 'e2e/b.ts'], unrecognized: ['e2e/b.ts'] }), ctx);
    expect(text).toBe(
      [
        'depwave shadow 0123456789ab...HEAD: 2 failing test files NOT selected ✘',
        '  a selective run would have run 3 of 40 test files (93% skipped)',
        '  missed: a.test.ts',
        '  missed: e2e/b.ts (not recognized as a test file)',
        '  Each one is either a flaky test or a dependency depwave did not see. Run `depwave why <test>` to check, and please report the second kind.',
        '  ⚠ 1 result file depwave does not see as tests: e2e/b.ts',
        '',
      ].join('\n'),
    );
  });

  it('markdown: inconclusive and run-all are explained, not shown as a pass', () => {
    const inconclusive = renderShadowMarkdown(result({ verdict: 'inconclusive', unattributedFailures: 2 }), ctx);
    expect(inconclusive).toContain('#### 🕵️ Shadow check: 2 failures could not be traced to a test file ⚠️');
    expect(inconclusive).toContain('> [!WARNING]');

    const runAll = renderShadowMarkdown(result({ runAll: true, failed: ['a.test.ts'], caught: ['a.test.ts'] }), ctx);
    expect(runAll).toContain('all 1 failing test file selected ✅');
    expect(runAll).toContain('a global trigger selected every test.');
  });

  it('markdown: no failures is still worth a line (the track record), with the savings', () => {
    expect(renderShadowMarkdown(result({}), ctx)).toContain('no failures, nothing to miss ✅\n\nCompared against the full test run of `HEAD`: a selective run would have run 3 of 40 test files (93% skipped).');
  });
});
