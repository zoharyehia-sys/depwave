import type { ShadowHistory } from '@depwave/core';

const MAX_LISTED = 20;
const short = (rev: string) => (/^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 12) : rev);
const count = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, word: string) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;
/** Rounded down: a bound shown as 99.90% must not be 99.899%. */
const pct = (x: number) => `${(Math.floor(x * 10000) / 100).toFixed(2)}%`;

function headline(h: ShadowHistory): string {
  if (h.failures === 0) return 'no failures observed yet, so recall cannot be measured';
  const missed = h.missed.length === 0 ? 'none missed' : `${count(h.missed.length)} missed`;
  return `${plural(h.failures, 'failure')} observed, ${missed} (recall ${pct(h.recall!)})`;
}

function evidence(h: ShadowHistory): string {
  const goal = `recall ≥ ${pct(h.target)}`;
  if (h.failuresNeeded === 0) return `at ${pct(h.confidence)} confidence, recall is at least ${pct(h.recallLowerBound!)}: enough to show ${goal}`;
  const more = Number.isFinite(h.failuresNeeded) ? `${count(h.failuresNeeded)} more` : 'no number of';
  const bound = h.recallLowerBound === undefined ? '' : `at ${pct(h.confidence)} confidence, recall is at least ${pct(h.recallLowerBound)}. `;
  return `${bound}${more} failures, none missed, would show ${goal}`;
}

/**
 *   depwave shadow history: 412 failures observed, none missed (recall 100.00%)
 *     runs: 120 (95 tested the selection, 25 selected everything), 3 incomplete
 *     evidence: at 95.00% confidence, recall is at least 99.27%. 2,583 more failures, none missed, would show recall ≥ 99.90%
 *     savings: a selective run would have skipped 64% of test files on average
 */
export function renderShadowHistoryText(h: ShadowHistory, emptyFiles: readonly string[] = []): string {
  const mark = h.missed.length > 0 ? ' ✘' : '';
  const runs = `${count(h.runs)} (${count(h.selectionRuns)} tested the selection, ${count(h.runAllRuns)} selected everything)`;
  const lines = [
    `depwave shadow history: ${headline(h)}${mark}`,
    `  runs: ${runs}${h.incompleteRuns > 0 ? `, ${count(h.incompleteRuns)} incomplete` : ''}`,
    `  evidence: ${evidence(h)}`,
  ];
  if (h.averageSkipped !== undefined) lines.push(`  savings: a selective run would have skipped ${Math.round(h.averageSkipped * 100)}% of test files on average`);
  if (h.missed.length > 0) {
    lines.push('  missed:');
    for (const miss of h.missed.slice(0, MAX_LISTED)) {
      lines.push(`    ${short(miss.head)} ${miss.path}${miss.discovery ? ' (not recognized as a test file)' : ''}`);
    }
    if (h.missed.length > MAX_LISTED) lines.push(`    … and ${count(h.missed.length - MAX_LISTED)} more (--format json lists all)`);
    lines.push('  Each is a flaky test or a dependency depwave did not see. Check with `depwave why <test> --base <base> --head <commit>` (--format json has both).');
  }
  if (emptyFiles.length > 0) {
    lines.push(`  ⚠ ${plural(emptyFiles.length, 'empty result file')} skipped: depwave shadow failed in those runs, so a miss there went unseen`);
    for (const file of emptyFiles.slice(0, MAX_LISTED)) lines.push(`    ${file}`);
  }
  if (h.unattributedFailures > 0) lines.push(`  ⚠ ${plural(h.unattributedFailures, 'failure')} named no test file, so they could not be checked`);
  return `${lines.join('\n')}\n`;
}
