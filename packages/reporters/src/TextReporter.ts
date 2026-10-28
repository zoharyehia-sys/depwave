import type { ImpactReport, Reporter, TestPlan } from '@depwave/core';
import { groupTriggers, listPaths } from './triggers.js';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const short = (rev: string) => (/^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 12) : rev);

export class TextReporter implements Reporter {
  readonly format = 'text';

  render(report: ImpactReport, plan: TestPlan): string {
    const testCount = plan.groups.reduce((n, g) => n + g.tests.length, 0);
    const lines = [
      `depwave impact ${short(report.base)}...${short(report.head)} (${report.granularity} level)`,
      `  changed files:  ${report.changedFiles.length}`,
      `  impacted nodes: ${report.impacted.length}`,
      `  impacted tests: ${testCount}`,
    ];
    for (const { sample, paths } of groupTriggers(report.globalTriggers)) {
      const reach = sample.scope === undefined ? ', everything' : sample.kind === 'lockfile' ? `, ${plural(sample.scope.length, 'package')}` : '';
      lines.push(`  trigger:        ${listPaths(paths)} (${sample.kind}${reach}${sample.detail ? `: ${sample.detail}` : ''})`);
    }
    for (const warning of report.warnings ?? []) lines.push(`  ⚠ ${warning}`);
    if (report.unresolved.length > 0) {
      lines.push(`  ⚠ unresolved imports: ${report.unresolved.length} (see --format json)`);
    }
    lines.push('');

    if (plan.runAll) lines.push('Run ALL tests (a global trigger fired).');
    if (plan.groups.length === 0) lines.push('No impacted tests.');
    for (const group of plan.groups) {
      lines.push(`${group.packageName} (${group.runner}): ${group.tests.length} test file(s)`);
      for (const test of group.tests) lines.push(`  ${test}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
