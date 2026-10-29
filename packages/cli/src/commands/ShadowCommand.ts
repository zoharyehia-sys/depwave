import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareShadow } from '@depwave/core';
import { GitService } from '@depwave/git';
import { renderShadowMarkdown, renderShadowText } from '@depwave/reporters';
import { Command, Option } from 'clipanion';
import * as t from 'typanion';
import { createPipeline } from '../AnalysisPipeline.js';
import { parseTestResults, toShadowRun } from '../shadow/testResults.js';
import { EXIT_FAILURE } from './ImpactCommand.js';

/** A failing test was not selected: the one outcome shadow mode exists to catch. */
export const EXIT_MISSED = 3;

export class ShadowCommand extends Command {
  static override paths = [['shadow']];

  static override usage = Command.Usage({
    description: 'Check depwave against a full test run: did it select every test that failed?',
    details:
      'Shadow mode builds trust before you run only the selected tests: CI keeps running everything, and this command compares the failures with what depwave would have selected. Exits with 3 when a failing test was not selected. Reads Vitest/Jest JSON (`--reporter=json`, `--json`) and JUnit XML.',
    examples: [
      ['After `vitest run --reporter=json --outputFile=results.json`', '$0 shadow --base origin/main --results results.json'],
      ['Several runners / packages', '$0 shadow --results a/junit.xml --results b/results.json'],
    ],
  });

  results = Option.Array('--results', { required: true, description: 'Test results file (Vitest/Jest JSON or JUnit XML); repeatable' });
  resultsRoot = Option.String('--results-root', { description: 'Directory relative paths in the results are relative to (default: the repository root)' });
  base = Option.String('--base', 'origin/main', { description: 'Base revision (the merge-base with HEAD is used)' });
  head = Option.String('--head', 'HEAD', { description: 'Head revision the tests ran on' });
  format = Option.String('--format', 'text', { validator: t.isEnum(['text', 'json', 'markdown'] as const), description: 'Output format' });
  cwd = Option.String('--cwd', { description: 'Repository to analyze (defaults to the current directory)' });
  cache = Option.Boolean('--cache', true, { description: 'Use the persistent cache in .depwave/ (--no-cache to bypass)' });
  granularity = Option.String('--granularity', 'symbol', { validator: t.isEnum(['symbol', 'file'] as const), description: 'symbol (default) or file' });

  async execute(): Promise<number> {
    let closeCache = (): void => {};
    try {
      const cwd = this.cwd ?? process.cwd();
      // Read the results first: a wrong path should fail in milliseconds, not after a full analysis.
      const raw = this.results.map((file) => parseTestResults(readFileSync(resolve(cwd, file), 'utf8'), file));
      const repoRoot = await new GitService(cwd).root();
      const run = toShadowRun(raw, repoRoot, this.resultsRoot === undefined ? repoRoot : resolve(cwd, this.resultsRoot));
      if (run.outcomes.length === 0 && run.unattributedFailures === 0) {
        throw new Error(`no test files found in ${this.results.join(', ')} (were the tests run from this repository?)`);
      }

      const pipeline = await createPipeline(cwd, { cache: this.cache, granularity: this.granularity });
      closeCache = () => pipeline.deps.cache?.close();
      const { report, plan, testFiles } = await pipeline.impact({ base: this.base, head: this.head });
      const result = compareShadow(plan, run, new Set(testFiles));

      const context = { base: report.base, head: report.head };
      const output = {
        text: () => renderShadowText(result, context),
        markdown: () => renderShadowMarkdown(result, context),
        json: () => `${JSON.stringify({ ...context, granularity: report.granularity, shadow: result }, null, 2)}\n`,
      };
      this.context.stdout.write(output[this.format]());
      return result.verdict === 'missed' ? EXIT_MISSED : 0;
    } catch (error) {
      this.context.stderr.write(`depwave: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_FAILURE;
    } finally {
      closeCache(); // also on errors: Windows keeps open SQLite files locked
    }
  }
}
