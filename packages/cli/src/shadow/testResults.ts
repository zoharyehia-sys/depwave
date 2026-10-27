import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPosixPath, type ShadowRun, type TestFileOutcome } from '@depwave/core';

/** A result before its path is mapped into the repo: exactly what the runner wrote. */
export interface RawOutcome {
  file: string;
  status: TestFileOutcome['status'];
}

export interface RawResults {
  outcomes: RawOutcome[];
  unattributedFailures: number;
}

/** Parses Vitest/Jest JSON (`--reporter=json`, `--json`) or JUnit XML, sniffed from the content, not the file name. */
export function parseTestResults(content: string, source = 'test results'): RawResults {
  const text = content.replace(/^﻿/, '').trimStart();
  if (text.startsWith('{')) return parseJestJson(text, source);
  if (text.startsWith('<')) return parseJUnit(text);
  throw new Error(`${source}: not a Vitest/Jest JSON report or JUnit XML file`);
}

interface JestFileResult {
  name?: unknown;
  status?: unknown;
  assertionResults?: Array<{ status?: unknown }>;
}

/** Vitest's JSON reporter writes Jest's format: one `testResults` entry per test file, `name` = absolute path. */
function parseJestJson(text: string, source: string): RawResults {
  let data: { testResults?: JestFileResult[] };
  try {
    data = JSON.parse(text) as typeof data;
  } catch (error) {
    throw new Error(`${source}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!Array.isArray(data.testResults)) throw new Error(`${source}: JSON has no "testResults" array (use Vitest --reporter=json or Jest --json)`);

  const outcomes: RawOutcome[] = [];
  let unattributedFailures = 0;
  for (const file of data.testResults) {
    const status = jestStatus(file);
    if (typeof file.name === 'string' && file.name !== '') outcomes.push({ file: file.name, status });
    else if (status === 'failed') unattributedFailures++;
  }
  return { outcomes, unattributedFailures };
}

function jestStatus(file: JestFileResult): TestFileOutcome['status'] {
  const assertions = (file.assertionResults ?? []).map((a) => a.status);
  // A file that fails to load has status "failed" and no assertions at all.
  if (file.status === 'failed' || assertions.includes('failed')) return 'failed';
  if (assertions.length > 0 && assertions.every((s) => s === 'skipped' || s === 'pending' || s === 'todo' || s === 'disabled')) return 'skipped';
  return file.status === 'skipped' || file.status === 'pending' ? 'skipped' : 'passed';
}

const TAG = /<(\/?)(testsuite|testcase|failure|error|skipped)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const ATTR = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const PATH_LIKE = /[\\/]|\.(?:[cm]?[jt]sx?|py)$/;

/**
 * JUnit has no standard "file" field, so the file comes from (in order): testcase `file`, testsuite `file` or
 * `filepath`, then a path-like testcase `classname` or testsuite `name` (what Vitest writes). Failures that map to
 * no file are counted, never guessed.
 */
function parseJUnit(text: string): RawResults {
  const outcomes: RawOutcome[] = [];
  let unattributedFailures = 0;
  const suites: Array<Record<string, string>> = [];
  let testcase: { file: string | undefined; status: TestFileOutcome['status'] } | undefined;

  const finish = () => {
    if (!testcase) return;
    if (testcase.file !== undefined) outcomes.push({ file: testcase.file, status: testcase.status });
    else if (testcase.status === 'failed') unattributedFailures++;
    testcase = undefined;
  };

  for (const [, closing, tag, rawAttrs, selfClosing] of text.matchAll(TAG)) {
    const attrs = attributes(rawAttrs ?? '');
    if (tag === 'testsuite') {
      if (closing) suites.pop();
      else if (!selfClosing) suites.push(attrs);
    } else if (tag === 'testcase') {
      if (closing) {
        finish();
        continue;
      }
      finish();
      const suite = suites.at(-1) ?? {};
      testcase = { file: junitFile(attrs, suite), status: 'passed' };
      if (selfClosing) finish();
    } else if (!closing && testcase) {
      if (tag === 'skipped') {
        if (testcase.status === 'passed') testcase.status = 'skipped';
      } else {
        testcase.status = 'failed';
      }
    }
  }
  finish();
  return { outcomes, unattributedFailures };
}

function junitFile(testcase: Record<string, string>, suite: Record<string, string>): string | undefined {
  const explicit = testcase.file ?? suite.file ?? suite.filepath;
  if (explicit) return explicit;
  for (const candidate of [testcase.classname, suite.name]) if (candidate && PATH_LIKE.test(candidate)) return candidate;
  return undefined;
}

function attributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const [, name, double, single] of raw.matchAll(ATTR)) attrs[name!] = decodeXml(double ?? single ?? '');
  return attrs;
}

const decodeXml = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, entity: string) => {
    const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    if (entity[0] !== '#') return named[entity.toLowerCase()]!;
    return String.fromCodePoint(entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
  });

/**
 * Maps runner paths into the repo: absolute paths as-is, relative ones against `resultsRoot` (where the runner ran).
 * Real paths are compared, so 8.3 short names, symlinks and drive-letter case don't produce `../..` garbage.
 * Files outside the repo are dropped.
 */
export function toShadowRun(results: readonly RawResults[], repoRoot: string, resultsRoot: string): ShadowRun {
  const root = realpath(repoRoot);
  const outcomes: TestFileOutcome[] = [];
  let unattributedFailures = 0;
  for (const result of results) {
    unattributedFailures += result.unattributedFailures;
    for (const { file, status } of result.outcomes) {
      const absolute = resolve(resultsRoot, file.startsWith('file:') ? fileURLToPath(file) : file);
      // Real paths first; the plain spelling covers files that no longer exist (realpath can't resolve those).
      const path = [relative(root, realpath(absolute)), relative(repoRoot, absolute)].find(inside);
      if (path === undefined) {
        if (status === 'failed') unattributedFailures++;
        continue;
      }
      outcomes.push({ path: toPosixPath(path), status });
    }
  }
  return { outcomes, unattributedFailures };
}

const inside = (path: string): boolean => path !== '' && !path.startsWith('..') && !isAbsolute(path);
const realpath = (path: string): string => (existsSync(path) ? realpathSync.native(path) : path);
