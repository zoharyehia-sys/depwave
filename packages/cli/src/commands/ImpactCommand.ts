import { NotImplementedError, type Reporter } from '@depwave/core';
import { JsonReporter, TextReporter } from '@depwave/reporters';
import { Command, Option } from 'clipanion';
import * as t from 'typanion';
import { createPipeline } from '../AnalysisPipeline.js';

const FORMATS = ['text', 'json'] as const;
type Format = (typeof FORMATS)[number];

const REPORTERS: Record<Format, () => Reporter> = {
  text: () => new TextReporter(),
  json: () => new JsonReporter(),
};

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
  format = Option.String('--format', 'text', { validator: t.isEnum(FORMATS), description: 'Output format' });
  cwd = Option.String('--cwd', { description: 'Repository to analyze (defaults to the current directory)' });
  cache = Option.Boolean('--cache', true, { description: 'Use the persistent cache in .depwave/ (--no-cache to bypass)' });

  async execute(): Promise<number> {
    try {
      const pipeline = await createPipeline(this.cwd ?? process.cwd(), { cache: this.cache });
      const { report, plan, stats } = await pipeline.impact({ base: this.base, head: this.head });
      pipeline.deps.cache?.close();
      if (stats.cacheWarning) this.context.stderr.write(`depwave: warning: ${stats.cacheWarning}\n`);
      this.context.stdout.write(REPORTERS[this.format]().render(report, plan));
      return 0;
    } catch (error) {
      // Users get one clear line, not a stack trace. The exit code tells CI what kind of failure it was.
      this.context.stderr.write(`depwave: ${error instanceof Error ? error.message : String(error)}\n`);
      return error instanceof NotImplementedError ? EXIT_NOT_IMPLEMENTED : EXIT_FAILURE;
    }
  }
}
