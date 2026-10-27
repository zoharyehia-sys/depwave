import { explainImpact, NotImplementedError, type Explanation, type GraphView, type ImpactReport, type Reporter, type TestPlan } from '@depwave/core';
import { JsonReporter, MarkdownReporter, TextReporter } from '@depwave/reporters';
import { Command, Option } from 'clipanion';
import * as t from 'typanion';
import { createPipeline } from '../AnalysisPipeline.js';

const FORMATS = ['text', 'json', 'markdown'] as const;
type Format = (typeof FORMATS)[number];

const REPORTERS: Record<Format, (explanations: Explanation[]) => Reporter> = {
  text: () => new TextReporter(),
  json: () => new JsonReporter(),
  markdown: (explanations) => new MarkdownReporter(explanations),
};

/**
 * `depwave why` for the N highest-ranked tests reached THROUGH other code (closest, most certain first).
 * Tests the diff changed directly are skipped: their explanation is just "changed", which tells a reviewer nothing.
 */
export function explainTopTests(report: ImpactReport, plan: TestPlan, graph: GraphView, limit: number): Explanation[] {
  const byPath = new Map(report.impacted.map((n) => [n.id.slice('file:'.length), n]));
  const tests = plan.groups
    .flatMap((g) => g.tests)
    .filter((t) => (byPath.get(t)?.distance ?? 0) > 0)
    .sort((a, b) => (byPath.get(b)?.score ?? 0) - (byPath.get(a)?.score ?? 0) || (a < b ? -1 : 1));
  return tests.slice(0, limit).map((test) => explainImpact(test, report, graph));
}

/** Analysis failed (not a git repo, unknown revision, broken manifest, ...). */
export const EXIT_FAILURE = 1;
/** Exit code for "feature not built yet", distinct from analysis failures. */
export const EXIT_NOT_IMPLEMENTED = 2;

export class ImpactCommand extends Command {
  static override paths = [['impact']];

  static override usage = Command.Usage({
    description: 'Compute the blast radius of a git diff: impacted symbols, packages and tests.',
    examples: [
      ['Compare the current branch with main', '$0 impact --base origin/main'],
      ['Machine-readable output for CI', '$0 impact --base origin/main --format json'],
    ],
  });

  base = Option.String('--base', 'origin/main', { description: 'Base revision (the merge-base with HEAD is used)' });
  head = Option.String('--head', 'HEAD', { description: 'Head revision, or WORKTREE for uncommitted changes' });
  format = Option.String('--format', 'text', { validator: t.isEnum(FORMATS), description: 'Output format (markdown: for PR comments)' });
  explain = Option.String('--explain', '3', { validator: t.isNumber(), description: 'markdown: include depwave why for the top N tests (0 = none)' });
  cwd = Option.String('--cwd', { description: 'Repository to analyze (defaults to the current directory)' });
  cache = Option.Boolean('--cache', true, { description: 'Use the persistent cache in .depwave/ (--no-cache to bypass)' });
  granularity = Option.String('--granularity', 'symbol', {
    validator: t.isEnum(['symbol', 'file'] as const),
    description: 'symbol (precise, default) or file (Phase 1 file-level analysis)',
  });

  async execute(): Promise<number> {
    try {
      const pipeline = await createPipeline(this.cwd ?? process.cwd(), { cache: this.cache, granularity: this.granularity });
      const { report, plan, stats, graph } = await pipeline.impact({ base: this.base, head: this.head });
      pipeline.deps.cache?.close();
      if (stats.cacheWarning) this.context.stderr.write(`depwave: warning: ${stats.cacheWarning}\n`);
      const explanations = this.format === 'markdown' && !plan.runAll ? explainTopTests(report, plan, graph, this.explain) : [];
      this.context.stdout.write(REPORTERS[this.format](explanations).render(report, plan));
      return 0;
    } catch (error) {
      // Users get one clear line, not a stack trace. The exit code tells CI what kind of failure it was.
      this.context.stderr.write(`depwave: ${error instanceof Error ? error.message : String(error)}\n`);
      return error instanceof NotImplementedError ? EXIT_NOT_IMPLEMENTED : EXIT_FAILURE;
    }
  }
}
