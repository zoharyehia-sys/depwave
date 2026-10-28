import { exportGraph } from '@depwave/core';
import { renderDot, renderMermaid } from '@depwave/reporters';
import { Command, Option } from 'clipanion';
import * as t from 'typanion';
import { createPipeline } from '../AnalysisPipeline.js';
import { EXIT_FAILURE } from './ImpactCommand.js';

export class GraphCommand extends Command {
  static override paths = [['graph']];

  static override usage = Command.Usage({
    description: 'Draw the dependency graph: workspace packages, or the files of one package, as Mermaid or Graphviz DOT.',
    details:
      'The package level shows declared workspace dependencies. The file level shows imports (dynamic and type-only ones drawn dashed and dotted), highlights test files and files in an import cycle, and with `--package` keeps one package, drawing imports that leave it as edges to the target package.',
    examples: [
      ['Packages as a Mermaid diagram', '$0 graph'],
      ["One package's files, rendered with Graphviz", '$0 graph --level file --package @acme/ui --format dot | dot -Tsvg > ui.svg'],
    ],
  });

  level = Option.String('--level', 'package', { validator: t.isEnum(['package', 'file'] as const), description: 'package (default) or file' });
  package = Option.String('--package', { description: 'File level: only the files of this workspace package' });
  format = Option.String('--format', 'mermaid', { validator: t.isEnum(['mermaid', 'dot', 'json'] as const), description: 'mermaid (default), dot or json' });
  rev = Option.String('--rev', 'HEAD', { description: 'Revision to draw, or WORKTREE for uncommitted changes' });
  cwd = Option.String('--cwd', { description: 'Repository to analyze (defaults to the current directory)' });
  cache = Option.Boolean('--cache', true, { description: 'Use the persistent cache in .depwave/ (--no-cache to bypass)' });

  async execute(): Promise<number> {
    let closeCache = (): void => {};
    try {
      if (this.package !== undefined && this.level !== 'file') throw new Error('--package needs --level file');
      const pipeline = await createPipeline(this.cwd ?? process.cwd(), { cache: this.cache, granularity: 'file' });
      closeCache = () => pipeline.deps.cache?.close();
      const { graph } = await pipeline.graphAt(this.rev);
      const exported = exportGraph(graph, { level: this.level, ...(this.package === undefined ? {} : { package: this.package }) });
      const output = { mermaid: renderMermaid, dot: renderDot, json: (g: typeof exported) => `${JSON.stringify(g, null, 2)}\n` };
      this.context.stdout.write(output[this.format](exported));
      return 0;
    } catch (error) {
      this.context.stderr.write(`depwave: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_FAILURE;
    } finally {
      closeCache(); // also on errors: Windows keeps open SQLite files locked
    }
  }
}
