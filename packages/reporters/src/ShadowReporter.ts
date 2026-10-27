import type { ShadowResult } from '@depwave/core';
import { listPaths } from './triggers.js';

export interface ShadowContext {
  base: string;
  head: string;
}

const MAX_LISTED = 10;
const short = (rev: string) => (/^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 12) : rev);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What a selective run would have saved: "would have run 3 of 41 test files (93% skipped)". */
function savings(result: ShadowResult): string {
  if (result.runAll) return 'a global trigger selected every test';
  const skipped = result.ran > 0 ? ` (${Math.max(0, Math.round((1 - result.selected / result.ran) * 100))}% skipped)` : '';
  return `a selective run would have run ${result.selected} of ${plural(result.ran, 'test file')}${skipped}`;
}

function headline(result: ShadowResult): string {
  switch (result.verdict) {
    case 'missed':
      return `${plural(result.missed.length, 'failing test file')} NOT selected`;
    case 'inconclusive':
      return `${plural(result.unattributedFailures, 'failure')} could not be traced to a test file`;
    case 'sound':
      return result.failed.length === 0 ? 'no failures, nothing to miss' : `all ${plural(result.failed.length, 'failing test file')} selected`;
  }
}

const MISSED_HINT = 'Each one is either a flaky test or a dependency depwave did not see. Run `depwave why <test>` to check, and please report the second kind.';

/**
 *   depwave shadow 0123456789ab...HEAD: 1 failing test file NOT selected ✘
 *     a selective run would have run 3 of 41 test files (93% skipped)
 *     missed: packages/app/src/cart.test.ts
 */
export function renderShadowText(result: ShadowResult, ctx: ShadowContext): string {
  const mark = result.verdict === 'sound' ? '✔' : result.verdict === 'missed' ? '✘' : '?';
  const lines = [`depwave shadow ${short(ctx.base)}...${short(ctx.head)}: ${headline(result)} ${mark}`, `  ${savings(result)}`];
  if (result.caught.length > 0) lines.push(`  caught: ${listPaths(result.caught, MAX_LISTED)}`);
  for (const path of result.missed) lines.push(`  missed: ${path}${result.unrecognized.includes(path) ? ' (not recognized as a test file)' : ''}`);
  if (result.missed.length > 0) lines.push(`  ${MISSED_HINT}`);
  if (result.unrecognized.length > 0) lines.push(`  ⚠ ${plural(result.unrecognized.length, 'result file')} depwave does not see as tests: ${listPaths(result.unrecognized)}`);
  return `${lines.join('\n')}\n`;
}

/** A section for the PR comment / job summary (appended under the impact report). */
export function renderShadowMarkdown(result: ShadowResult, ctx: ShadowContext): string {
  const icon = result.verdict === 'sound' ? '✅' : result.verdict === 'missed' ? '❌' : '⚠️';
  const lines = [`#### 🕵️ Shadow check: ${headline(result)} ${icon}`, '', `Compared against the full test run of \`${short(ctx.head)}\`: ${savings(result)}.`, ''];
  if (result.missed.length > 0) {
    lines.push('> [!CAUTION]', '> These tests failed, but depwave did not select them:');
    for (const path of result.missed.slice(0, MAX_LISTED)) lines.push(`> - \`${path}\`${result.unrecognized.includes(path) ? ' (not recognized as a test file)' : ''}`);
    if (result.missed.length > MAX_LISTED) lines.push(`> - … and ${result.missed.length - MAX_LISTED} more`);
    lines.push('>', `> ${MISSED_HINT}`, '');
  }
  if (result.caught.length > 0) lines.push(`Caught: ${listPaths(result.caught, MAX_LISTED, (p) => `\`${p}\``)}.`, '');
  if (result.verdict === 'inconclusive') {
    lines.push(
      '> [!WARNING]',
      '> Some failures name no file (JUnit without `file`/`classname` paths) or a file outside this repository (wrong `--results-root`?), so they could not be checked.',
      '',
    );
  }
  if (result.unrecognized.length > 0) {
    lines.push('> [!NOTE]', `> depwave does not classify ${listPaths(result.unrecognized, 3, (p) => `\`${p}\``)} as test files, so it can never select them.`, '');
  }
  return lines.join('\n');
}
