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
  const total = result.totalTests;
  const skipped = total > 0 ? ` (${Math.max(0, Math.round((1 - result.selected / total) * 100))}% skipped)` : '';
  return `a selective run would have run ${result.selected} of ${plural(total, 'test file')}${skipped}`;
}

function headline(result: ShadowResult): string {
  switch (result.verdict) {
    case 'missed':
      return `${plural(result.missed.length, 'failing test file')} NOT selected`;
    case 'inconclusive':
      return result.partial
        ? `no miss seen, but ${result.notRun.length} of ${plural(result.totalTests, 'test file')} have no result`
        : `${plural(result.unattributedFailures, 'failure')} could not be traced to a test file`;
    case 'sound':
      return result.failed.length === 0 ? 'no failures, nothing to miss' : `all ${plural(result.failed.length, 'failing test file')} selected`;
  }
}

const MISSED_HINT = 'Each one is either a flaky test or a dependency depwave did not see. Run `depwave why <test>` to check, and please report the second kind.';
const NOT_RUN_HINT =
  "A failure there would go unchecked. Pass their results too (--results), or keep tests your runners don't run out of the analysis (depwave.config.json `ignore`).";

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
  if (result.partial && !result.runAll) lines.push(`  no result for: ${listPaths(result.notRun, MAX_LISTED)}`, `  ${NOT_RUN_HINT}`);
  if (result.partial && result.unattributedFailures > 0) lines.push(`  ${plural(result.unattributedFailures, 'failure')} could not be traced to a test file`);
  if (result.unrecognized.length > 0) lines.push(`  ⚠ ${plural(result.unrecognized.length, 'result file')} depwave does not see as tests: ${listPaths(result.unrecognized)}`);
  return `${lines.join('\n')}\n`;
}

/** A section for the PR comment / job summary (appended under the impact report). */
export function renderShadowMarkdown(result: ShadowResult, ctx: ShadowContext): string {
  const icon = result.verdict === 'sound' ? '✅' : result.verdict === 'missed' ? '❌' : '⚠️';
  const lines = [`#### 🕵️ Shadow check: ${headline(result)} ${icon}`, '', `Compared against the test run of \`${short(ctx.head)}\`: ${savings(result)}.`, ''];
  if (result.missed.length > 0) {
    lines.push('> [!CAUTION]', '> These tests failed, but depwave did not select them:');
    for (const path of result.missed.slice(0, MAX_LISTED)) lines.push(`> - \`${path}\`${result.unrecognized.includes(path) ? ' (not recognized as a test file)' : ''}`);
    if (result.missed.length > MAX_LISTED) lines.push(`> - … and ${result.missed.length - MAX_LISTED} more`);
    lines.push('>', `> ${MISSED_HINT}`, '');
  }
  if (result.caught.length > 0) lines.push(`Caught: ${listPaths(result.caught, MAX_LISTED, (p) => `\`${p}\``)}.`, '');
  if (result.partial && !result.runAll) {
    lines.push(
      '> [!WARNING]',
      `> ${plural(result.notRun.length, 'test file')} depwave knows ${result.notRun.length === 1 ? 'has' : 'have'} no result, so this run can't confirm depwave would have caught a failure there: ${listPaths(result.notRun, 3, (p) => `\`${p}\``)}.`,
      `> ${NOT_RUN_HINT}`,
      '',
    );
  }
  if (result.unattributedFailures > 0 && !result.runAll) {
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
