import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { explainImpact, toPosixPath } from '@depwave/core';
import { GitService } from '@depwave/git';
import { renderWhy } from '@depwave/reporters';
import { Command, Option } from 'clipanion';
import * as t from 'typanion';
import { createPipeline } from '../AnalysisPipeline.js';
import { EXIT_FAILURE } from './ImpactCommand.js';

export class WhyCommand extends Command {
  static override paths = [['why']];

  static override usage = Command.Usage({
    description: 'Explain why a file (usually a test) is impacted by a diff: the chain from a change to it.',
    details: 'Shows the shortest dependency path from a changed symbol or file to the target, naming each relation (calls, uses, re-exports, imports dynamically). Steps depwave cannot prove statically are marked `~`.',
    examples: [
      ['Why does my branch run this test?', '$0 why packages/app/src/checkout.test.ts --base origin/main'],
      ['Explain against uncommitted work', '$0 why src/a.test.ts --base main --head WORKTREE'],
    ],
  });

  target = Option.String({ name: 'file' });
  base = Option.String('--base', 'origin/main', { description: 'Base revision (the merge-base with HEAD is used)' });
  head = Option.String('--head', 'HEAD', { description: 'Head revision, or WORKTREE for uncommitted changes' });
  format = Option.String('--format', 'text', { validator: t.isEnum(['text', 'json'] as const), description: 'Output format' });
  cwd = Option.String('--cwd', { description: 'Repository to analyze (defaults to the current directory)' });
  cache = Option.Boolean('--cache', true, { description: 'Use the persistent cache in .depwave/ (--no-cache to bypass)' });
  granularity = Option.String('--granularity', 'symbol', { validator: t.isEnum(['symbol', 'file'] as const), description: 'symbol (default) or file' });

  async execute(): Promise<number> {
    let closeCache = (): void => {};
    try {
      const cwd = this.cwd ?? process.cwd();
      const target = repoRelative(this.target, cwd, await new GitService(cwd).root());
      const pipeline = await createPipeline(cwd, { cache: this.cache, granularity: this.granularity });
      closeCache = () => pipeline.deps.cache?.close();
      const { report, graph } = await pipeline.impact({ base: this.base, head: this.head });

      const explanation = explainImpact(target, report, graph);
      const context = { base: report.base, head: report.head, granularity: report.granularity };
      this.context.stdout.write(this.format === 'json' ? `${JSON.stringify({ ...context, explanation }, null, 2)}\n` : renderWhy(explanation, context));
      return explanation.kind === 'unknown' ? EXIT_FAILURE : 0;
    } catch (error) {
      this.context.stderr.write(`depwave: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_FAILURE;
    } finally {
      closeCache(); // also on errors: Windows keeps open SQLite files locked
    }
  }
}

/**
 * Accepts a path relative to where you are (works from subdirectories, tab completion friendly), an absolute path,
 * or a repo-relative path. A path that exists relative to `cwd` wins; otherwise it's taken as repo-relative.
 */
export function repoRelative(target: string, cwd: string, repoRoot: string): string {
  const fromCwd = isAbsolute(target) ? target : resolve(cwd, target);
  if (!isAbsolute(target) && !existsSync(fromCwd)) return toPosixPath(target);
  // Compare real paths: the same folder can be spelled differently (Windows 8.3 short names such as RUNNER~1,
  // junctions/symlinks, drive-letter case). A naive relative() between two spellings yields `../../…` garbage.
  const rel = relative(realpath(repoRoot), realpath(fromCwd));
  return toPosixPath(rel === '' || rel.startsWith('..') || isAbsolute(rel) ? target : rel);
}

const realpath = (path: string): string => (existsSync(path) ? realpathSync.native(path) : path);
