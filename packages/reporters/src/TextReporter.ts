import type { ImpactReport, Reporter, TestPlan } from '@depwave/core';

export class TextReporter implements Reporter {
  readonly format = 'text';

  render(report: ImpactReport, plan: TestPlan): string {
    const lines = [
      `depwave impact ${report.base}...${report.head}`,
      `  changed:  ${report.seeds.length} node(s)`,
      `  impacted: ${report.impacted.length} node(s)`,
      '',
    ];

    if (plan.runAll) {
      lines.push('Run ALL tests (a global trigger fired).');
    } else if (plan.groups.length === 0) {
      lines.push('No impacted tests.');
    } else {
      for (const group of plan.groups) {
        lines.push(`${group.packageName} (${group.runner}): ${group.tests.length} test file(s)`);
        for (const test of group.tests) lines.push(`  ${test}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}
