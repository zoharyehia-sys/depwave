#!/usr/bin/env node
// @ts-check
/**
 * Turns depwave's JSON report into the action's step outputs.
 *
 * Usage (inside GitHub Actions): FULL_RUN=true|false node plan-outputs.mjs <report.json> >> "$GITHUB_OUTPUT"
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @param {{ runAll: boolean, totalTests?: number, groups: ReadonlyArray<{ tests: readonly string[] }> }} plan
 * @param {boolean} fullRun no pull request to compare against (`schedule`, `push`, …): HEAD against its own branch is
 *   an empty diff, which would read as "no tests are impacted" and turn a nightly full run into no run at all.
 * @returns {string[]} `name=value` lines
 */
export function planOutputs(plan, fullRun) {
  const tests = plan.groups.flatMap((g) => g.tests);
  return [
    `impacted-tests=${tests.length}`,
    `total-tests=${plan.totalTests ?? ''}`,
    `run-all=${plan.runAll || fullRun}`,
    `tests=${tests.join(' ')}`,
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { plan } = JSON.parse(readFileSync(/** @type {string} */ (process.argv[2]), 'utf8'));
  for (const line of planOutputs(plan, process.env['FULL_RUN'] === 'true')) console.log(line);
}
