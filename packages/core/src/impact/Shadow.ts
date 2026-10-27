import type { TestPlan } from '../model/impact.js';
import type { ShadowResult, ShadowRun, TestFileOutcome } from '../model/shadow.js';

/**
 * Compares a selection with a full test run. `isTest` says whether depwave classifies a path as a test file at head;
 * results outside that set are reported as `unrecognized`, since depwave could never select them.
 */
export function compareShadow(plan: TestPlan, run: ShadowRun, isTest: (path: string) => boolean): ShadowResult {
  const selected = new Set(plan.groups.flatMap((g) => g.tests));
  const byFile = mergeByFile(run.outcomes);

  const failed = [...byFile].filter(([, status]) => status === 'failed').map(([path]) => path).sort();
  const caught = plan.runAll ? failed : failed.filter((p) => selected.has(p));
  const missed = plan.runAll ? [] : failed.filter((p) => !selected.has(p));
  const unrecognized = [...byFile.keys()].filter((p) => !isTest(p)).sort();

  let verdict: ShadowResult['verdict'] = 'sound';
  if (missed.length > 0) verdict = 'missed';
  else if (run.unattributedFailures > 0 && !plan.runAll) verdict = 'inconclusive';

  return {
    verdict,
    runAll: plan.runAll,
    selected: selected.size,
    ran: byFile.size,
    failed,
    caught,
    missed,
    unrecognized,
    unattributedFailures: run.unattributedFailures,
  };
}

/** A file can appear several times (multiple result files, retries, JUnit suites): any failure wins. */
function mergeByFile(outcomes: readonly TestFileOutcome[]): Map<string, TestFileOutcome['status']> {
  const rank = { skipped: 0, passed: 1, failed: 2 } as const;
  const byFile = new Map<string, TestFileOutcome['status']>();
  for (const { path, status } of outcomes) {
    const previous = byFile.get(path);
    if (previous === undefined || rank[status] > rank[previous]) byFile.set(path, status);
  }
  return byFile;
}
