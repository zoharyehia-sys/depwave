import { findImportCycles } from '@depwave/core';
import { renderCyclesText } from '@depwave/reporters';
import { Command, Option } from 'clipanion';
import * as t from 'typanion';
import { createPipeline } from '../AnalysisPipeline.js';
import { EXIT_FAILURE } from './ImpactCommand.js';

/** Import cycles were found: lets CI use `depwave cycles` as a lint. */
export const EXIT_CYCLES = 4;

export class CyclesCommand extends Command {
  static override paths = [['cycles']];

  static override usage = Command.Usage({
    description: 'List import cycles: groups of files that import each other, directly or through other files.',
    details:
      'Follows runtime imports and re-exports; dynamic `import()` is skipped, since it loads only when called. Each cycle is shown as its shortest loop. Exits with 4 when there is at least one cycle, so CI can use it as a lint.',
    examples: [
      ['Cycles in the current commit', '$0 cycles'],
      ['Include uncommitted changes, and type-only imports', '$0 cycles --rev WORKTREE --include-type-only'],
    ],
  });

  rev = Option.String('--rev', 'HEAD', { description: 'Revision to check, or WORKTREE for uncommitted changes' });
  format = Option.String('--format', 'text', { validator: t.isEnum(['text', 'json'] as const), description: 'Output format' });
  includeTypeOnly = Option.Boolean('--include-type-only', false, { description: 'Count `import type` edges too' });
  cwd = Option.String('--cwd', { description: 'Repository to analyze (defaults to the current directory)' });
  cache = Option.Boolean('--cache', true, { description: 'Use the persistent cache in .depwave/ (--no-cache to bypass)' });

  async execute(): Promise<number> {
    let closeCache = (): void => {};
    try {
      // File granularity: cycles are between files, and its snapshot is cheaper than the symbol graph.
      const pipeline = await createPipeline(this.cwd ?? process.cwd(), { cache: this.cache, granularity: 'file' });
      closeCache = () => pipeline.deps.cache?.close();
      const { rev, graph, unresolved } = await pipeline.graphAt(this.rev);
      const cycles = findImportCycles(graph, { includeTypeOnly: this.includeTypeOnly });
      this.context.stdout.write(
        this.format === 'json'
          ? `${JSON.stringify({ rev, includeTypeOnly: this.includeTypeOnly, cycles, unresolved }, null, 2)}\n`
          : renderCyclesText(cycles, { rev, unresolved: unresolved.length, includeTypeOnly: this.includeTypeOnly }),
      );
      return cycles.length > 0 ? EXIT_CYCLES : 0;
    } catch (error) {
      this.context.stderr.write(`depwave: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_FAILURE;
    } finally {
      closeCache(); // also on errors: Windows keeps open SQLite files locked
    }
  }
}
