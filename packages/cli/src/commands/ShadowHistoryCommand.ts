import { readdirSync, readFileSync, type Stats, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { aggregateShadow, type ShadowRecord, type ShadowResult } from '@depwave/core';
import { renderShadowHistoryText } from '@depwave/reporters';
import { Command, Option } from 'clipanion';
import * as t from 'typanion';
import { EXIT_FAILURE } from './ImpactCommand.js';

const isProbability = t.cascade(t.isNumber(), [t.isInExclusiveRange(0, 1)]);

export class ShadowHistoryCommand extends Command {
  static override paths = [['shadow', 'history']];

  static override usage = Command.Usage({
    description: 'Add up many shadow runs: observed recall, how much evidence it rests on, and every miss.',
    details:
      'Reads the `depwave shadow --format json` files your CI saved (directories are searched recursively; other JSON files, such as impact reports, are skipped). Recall counts only runs where depwave chose a subset: when everything was selected, nothing could be missed. The same commit tested on several OSes counts as one run.',
    examples: [
      ['After downloading CI artifacts into runs/', '$0 shadow history --input runs'],
      ['Require 99.99% at 99% confidence', '$0 shadow history --input runs --target 0.9999 --confidence 0.99'],
    ],
  });

  // Not `required: true`: clipanion answers a missing required option with "Command not found".
  input = Option.Array('--input', { description: 'Shadow JSON file, or a directory of them; repeatable' });
  granularity = Option.String('--granularity', 'symbol', {
    validator: t.isEnum(['symbol', 'file'] as const),
    description: 'Count runs at this granularity only (default: symbol)',
  });
  confidence = Option.String('--confidence', '0.95', { validator: isProbability, description: 'Confidence of the recall bound (default: 0.95)' });
  target = Option.String('--target', '0.999', { validator: isProbability, description: 'Recall to show before skipping tests (default: 0.999)' });
  format = Option.String('--format', 'text', { validator: t.isEnum(['text', 'json'] as const), description: 'Output format' });

  async execute(): Promise<number> {
    try {
      const inputs = this.input ?? [];
      if (inputs.length === 0) throw new Error('shadow history needs --input <path>: a `depwave shadow --format json` file, or a directory of them');
      const { records: all, empty } = readShadowRecords(inputs.map((p) => resolve(p)));
      if (all.length === 0) throw new Error(`no depwave shadow results in ${inputs.join(', ')} (files written by \`depwave shadow --format json\`)`);
      const records = all.filter((r) => r.granularity === this.granularity);
      if (records.length === 0) throw new Error(`none of the ${all.length} shadow result(s) is at ${this.granularity} granularity (--granularity)`);

      const history = aggregateShadow(records, { confidence: this.confidence, target: this.target });
      const output =
        this.format === 'json'
          ? `${JSON.stringify({ granularity: this.granularity, history, emptyFiles: empty }, null, 2)}\n`
          : renderShadowHistoryText(history, empty);
      this.context.stdout.write(output);
      return 0;
    } catch (error) {
      this.context.stderr.write(`depwave: ${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_FAILURE;
    }
  }
}

/** An --input path, or an error that names it, instead of Node's raw `ENOENT: … stat '…'`. */
function inputStat(path: string): Stats {
  try {
    return statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`--input ${path}: no such file or directory`);
    throw error;
  }
}

/**
 * Every shadow result under `paths`, sorted by path so the output doesn't depend on the file system's order. A JSON
 * file without a top-level `shadow` is someone else's and is skipped; one that has it but can't be read is an error,
 * never silently dropped: a missing run could be the one with the miss.
 *
 * Empty files are the exception, because CI makes them: `depwave shadow --format json > f.json` creates the file even
 * when the command fails. They hold no result, so they're returned for the report to name, not counted.
 */
export function readShadowRecords(paths: readonly string[]): { records: ShadowRecord[]; empty: string[] } {
  const files = paths.flatMap((path) => (inputStat(path).isDirectory() ? jsonFilesUnder(path) : [path])).sort();
  const records: ShadowRecord[] = [];
  const empty: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
    if (text.trim() === '') {
      empty.push(file);
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    if (typeof data !== 'object' || data === null || !('shadow' in data)) continue;
    records.push(toRecord(data as Record<string, unknown>, file));
  }
  return { records, empty };
}

function jsonFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(entry.parentPath, entry.name));
}

const VERDICTS = new Set(['sound', 'missed', 'inconclusive']);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');

function toRecord(data: Record<string, unknown>, file: string): ShadowRecord {
  const s = data['shadow'] as Partial<ShadowResult> | null;
  const valid =
    typeof data['base'] === 'string' &&
    typeof data['head'] === 'string' &&
    typeof s === 'object' &&
    s !== null &&
    VERDICTS.has(s.verdict as string) &&
    typeof s.runAll === 'boolean' &&
    typeof s.selected === 'number' &&
    typeof s.unattributedFailures === 'number' &&
    [s.failed, s.caught, s.missed, s.unrecognized].every(strings) &&
    (s.notRun === undefined || strings(s.notRun)) &&
    (s.totalTests === undefined || typeof s.totalTests === 'number');
  if (!valid) throw new Error(`${file}: not a depwave shadow result this version can read`);
  // Older results: before `basis`, it follows from the fields it's derived from. Before `notRun` (the first shadow
  // releases), completeness wasn't checked, so the run counts as incomplete, and without `totalTests` it has no savings.
  const notRun = s.notRun ?? [];
  const basis = s.basis ?? { selectionTested: !s.runAll, complete: s.notRun !== undefined && notRun.length === 0 && s.unattributedFailures === 0 };
  return {
    base: data['base'] as string,
    head: data['head'] as string,
    granularity: typeof data['granularity'] === 'string' ? data['granularity'] : 'symbol',
    shadow: { ...(s as ShadowResult), notRun, partial: s.partial ?? s.notRun === undefined, totalTests: s.totalTests ?? 0, basis },
  };
}
