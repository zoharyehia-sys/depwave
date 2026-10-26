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

/** Exit code for "feature not built yet", distinct from analysis failures (1). */
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

  async execute(): Promise<number> {
    try {
      const { report, plan } = await createPipeline(process.cwd()).impact({ base: this.base, head: this.head });
      this.context.stdout.write(REPORTERS[this.format]().render(report, plan));
      return 0;
    } catch (error) {
      if (error instanceof NotImplementedError) {
        this.context.stderr.write(`depwave: ${error.message}\n`);
        return EXIT_NOT_IMPLEMENTED;
      }
      throw error;
    }
  }
}
