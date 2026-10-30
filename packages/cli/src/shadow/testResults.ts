import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toPosixPath, type ShadowRun, type TestFileOutcome } from '@depwave/core';
import { SaxesParser } from 'saxes';

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
  if (text.startsWith('<')) return parseJUnit(text, source);
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
    if (typeof file.name === 'string' && file.name !== '') {
      if (status) outcomes.push({ file: file.name, status });
    } else if (status === 'failed' || status === undefined) {
      unattributedFailures++;
    }
  }
  return { outcomes, unattributedFailures };
}

const FILE_STATUSES = new Set<unknown>(['passed', 'failed', 'skipped', 'pending']);
const ASSERTION_STATUSES = new Set<unknown>(['passed', 'failed', 'skipped', 'pending', 'todo', 'disabled', 'focused']);

/**
 * undefined: a result this code can't read. The file then has no result, which makes the run inconclusive; defaulting
 * to `passed` would let a new or broken status read as a success.
 */
function jestStatus(file: JestFileResult): TestFileOutcome['status'] | undefined {
  const assertions = (file.assertionResults ?? []).map((a) => a.status);
  // A file that fails to load has status "failed" and no assertions at all.
  if (file.status === 'failed' || assertions.includes('failed')) return 'failed';
  if (!assertions.every((s) => ASSERTION_STATUSES.has(s))) return undefined;
  if (file.status === undefined ? assertions.length === 0 : !FILE_STATUSES.has(file.status)) return undefined;
  if (assertions.length > 0 && assertions.every((s) => s === 'skipped' || s === 'pending' || s === 'todo' || s === 'disabled')) return 'skipped';
  return file.status === 'skipped' || file.status === 'pending' ? 'skipped' : 'passed';
}

const PATH_LIKE = /[\\/]|\.(?:[cm]?[jt]sx?|py)$/;

/** An open `<testsuite>` (or `<testsuites>`): what it says failed, and how much of that its children explain. */
interface JUnitSuite {
  attrs: Record<string, string>;
  /** `<failure>` / `<error>` elements seen inside it, nested suites included. */
  reported: number;
  /** A `<failure>` / `<error>` directly on the suite, outside any testcase. */
  ownFailure: boolean;
}

/**
 * JUnit has no standard "file" field, so the file comes from (in order): testcase `file`, testsuite `file` or
 * `filepath`, then a path-like testcase `classname` or testsuite `name` (what Vitest writes). Failures that map to
 * no file are counted, never guessed.
 *
 * A suite can fail with no testcase to show for it (a file that doesn't load): a failure element on the suite, or
 * `failures` + `errors` counts its children don't add up to. That's one failure of the suite itself.
 */
function parseJUnit(text: string, source: string): RawResults {
  const outcomes: RawOutcome[] = [];
  let unattributedFailures = 0;
  const suites: JUnitSuite[] = [];
  let testcase: { file: string | undefined; status: TestFileOutcome['status'] } | undefined;

  const finishTestcase = () => {
    if (!testcase) return;
    if (testcase.file !== undefined) outcomes.push({ file: testcase.file, status: testcase.status });
    else if (testcase.status === 'failed') unattributedFailures++;
    testcase = undefined;
  };
  const finishSuite = () => {
    const suite = suites.pop()!;
    const declared = (Number(suite.attrs.failures) || 0) + (Number(suite.attrs.errors) || 0);
    if (suite.ownFailure || declared > suite.reported) {
      const file = junitFile({}, suite.attrs);
      if (file !== undefined) outcomes.push({ file, status: 'failed' });
      else unattributedFailures++;
    }
    const parent = suites.at(-1);
    if (parent) parent.reported += Math.max(declared, suite.reported);
  };

  // Strict: a truncated or malformed report is an error, not a partial result. saxes never expands a DTD's entities.
  const parser = new SaxesParser();
  parser.on('error', (error) => {
    throw new Error(`${source}: invalid XML (${error.message})`);
  });
  parser.on('opentag', (tag) => {
    const name = localName(tag.name);
    if (name === 'testsuite' || name === 'testsuites') {
      suites.push({ attrs: tag.attributes, reported: 0, ownFailure: false });
    } else if (name === 'testcase') {
      testcase = { file: junitFile(tag.attributes, suites.at(-1)?.attrs ?? {}), status: 'passed' };
    } else if (name === 'failure' || name === 'error') {
      const suite = suites.at(-1);
      if (suite) suite.reported++;
      if (testcase) testcase.status = 'failed';
      else if (suite) suite.ownFailure = true;
    } else if (name === 'skipped' && testcase?.status === 'passed') {
      testcase.status = 'skipped';
    }
  });
  parser.on('closetag', (tag) => {
    const name = localName(tag.name);
    if (name === 'testcase') finishTestcase();
    else if (name === 'testsuite' || name === 'testsuites') finishSuite();
  });
  parser.write(text).close();
  return { outcomes, unattributedFailures };
}

const localName = (name: string): string => name.slice(name.indexOf(':') + 1);

function junitFile(testcase: Record<string, string>, suite: Record<string, string>): string | undefined {
  const explicit = testcase.file ?? suite.file ?? suite.filepath;
  if (explicit) return explicit;
  for (const candidate of [testcase.classname, suite.name]) if (candidate && PATH_LIKE.test(candidate)) return candidate;
  return undefined;
}

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
