import type { ImpactReport, Reporter, TestPlan } from '@depwave/core';

export class JsonReporter implements Reporter {
  readonly format = 'json';

  render(report: ImpactReport, plan: TestPlan): string {
    return `${JSON.stringify({ report, plan }, null, 2)}\n`;
  }
}
