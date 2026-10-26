import type { ImpactReport, Reporter, TestPlan } from '@depwave/core';

const short = (rev: string) => (/^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 12) : rev);

export class TextReporter implements Reporter {
  readonly format = 'text';

  render(report: ImpactReport, plan: TestPlan): string {
    const testCount = plan.groups.reduce((n, g) => n + g.tests.length, 0);
    const lines = [
      `depwave impact ${short(report.base)}...${short(report.head)}`,
      `  changed files:  ${report.changedFiles.length}`,
      `  impacted nodes: ${report.impacted.length}`,
      `  impacted tests: ${testCount}`,
    ];
    for (const trigger of report.globalTriggers) {
      lines.push(`  trigger:        ${trigger.path} (${trigger.kind}${trigger.scope === undefined ? ', everything' : ''})`);
    }
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
