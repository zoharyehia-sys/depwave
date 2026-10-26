import type { ImpactReport, TestPlan } from '../model/impact.js';

export type ReportFormat = 'text' | 'json' | 'markdown' | 'sarif' | 'mermaid';

export interface Reporter {
  readonly format: ReportFormat;
  render(report: ImpactReport, plan: TestPlan): string;
}
