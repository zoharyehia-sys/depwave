import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TempRepo } from '../../../../test/support/tempRepo.js';
import { parseTestResults, toShadowRun } from './testResults.js';

// Trimmed from real `vitest run --reporter=json` output (Vitest 3): a failing file, a file that failed to load
// (no assertions), a file with a skipped test, and a file whose only test is skipped.
const VITEST_JSON = JSON.stringify({
  numFailedTests: 1,
  testResults: [
    { name: 'C:/repo/src/bad.test.ts', status: 'failed', assertionResults: [{ status: 'failed' }] },
    { name: 'C:/repo/src/broken.test.ts', status: 'failed', assertionResults: [] },
    { name: 'C:/repo/src/ok.test.ts', status: 'passed', assertionResults: [{ status: 'passed' }, { status: 'skipped' }] },
    { name: 'C:/repo/src/skip.test.ts', status: 'passed', assertionResults: [{ status: 'skipped' }] },
  ],
});

// Trimmed from real `vitest run --reporter=junit` output.
const VITEST_JUNIT = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="5" failures="2" errors="0" time="0.01">
    <testsuite name="src/bad.test.ts" tests="1" failures="1" errors="0" skipped="0" time="0.01">
        <testcase classname="src/bad.test.ts" name="bad &lt;&amp;&gt;" time="0.008">
            <failure message="expected 1 to be 2 // Object.is equality" type="AssertionError">
AssertionError: expected 1 to be 2 // Object.is equality
 ❯ src/bad.test.ts:2:28
            </failure>
        </testcase>
    </testsuite>
    <testsuite name="src/broken.test.ts" tests="1" failures="1" errors="0" skipped="0" time="0">
        <testcase classname="src/broken.test.ts" name="src/broken.test.ts" time="0">
            <failure message="Cannot find module &apos;./nope&apos; imported from &apos;src/broken.test.ts&apos;" type="Error">
Error: Cannot find module &apos;./nope&apos;
            </failure>
        </testcase>
    </testsuite>
    <testsuite name="src/ok.test.ts" tests="2" failures="0" errors="0" skipped="1" time="0.002">
        <testcase classname="src/ok.test.ts" name="d &gt; ok" time="0.001">
        </testcase>
        <testcase classname="src/ok.test.ts" name="d &gt; s" time="0">
            <skipped/>
        </testcase>
    </testsuite>
    <testsuite name="src/skip.test.ts" tests="1" failures="0" errors="0" skipped="1" time="0">
        <testcase classname="src/skip.test.ts" name="s" time="0">
            <skipped/>
        </testcase>
    </testsuite>
</testsuites>
`;

describe('parseTestResults', () => {
  it('reads Vitest/Jest JSON: load failures count as failed, skip-only files as skipped', () => {
    expect(parseTestResults(VITEST_JSON)).toEqual({
      outcomes: [
        { file: 'C:/repo/src/bad.test.ts', status: 'failed' },
        { file: 'C:/repo/src/broken.test.ts', status: 'failed' },
        { file: 'C:/repo/src/ok.test.ts', status: 'passed' },
        { file: 'C:/repo/src/skip.test.ts', status: 'skipped' },
      ],
      unattributedFailures: 0,
    });
  });

  it('reads Vitest JUnit XML, file from the path-like classname', () => {
    const { outcomes, unattributedFailures } = parseTestResults(VITEST_JUNIT);
    expect(unattributedFailures).toBe(0);
    expect(outcomes).toEqual([
      { file: 'src/bad.test.ts', status: 'failed' },
      { file: 'src/broken.test.ts', status: 'failed' },
      { file: 'src/ok.test.ts', status: 'passed' },
      { file: 'src/ok.test.ts', status: 'skipped' },
      { file: 'src/skip.test.ts', status: 'skipped' },
    ]);
  });

  it('prefers explicit file attributes (jest-junit) and counts failures it cannot attribute instead of guessing', () => {
    const xml = `<testsuites>
      <testsuite name="Cart" filepath="/r/cart.test.js"><testcase classname="Cart adds" name="adds"><error/></testcase></testsuite>
      <testsuite name="Checkout"><testcase classname="Checkout pays" name="pays" file="/r/pay.test.js"/></testsuite>
      <testsuite name="Orphans"><testcase classname="tests.test_x.TestX" name="t"><failure/></testcase></testsuite>
    </testsuites>`;
    expect(parseTestResults(xml)).toEqual({
      outcomes: [
        { file: '/r/cart.test.js', status: 'failed' },
        { file: '/r/pay.test.js', status: 'passed' },
      ],
      unattributedFailures: 1,
    });
  });

  it('decodes attribute entities and tolerates a BOM', () => {
    const xml = '\uFEFF<testsuite name="a &amp; b/x&#46;test.ts"><testcase name="t"/></testsuite>';
    expect(parseTestResults(xml).outcomes).toEqual([{ file: 'a & b/x.test.ts', status: 'passed' }]);
  });

  it('rejects files that are neither format, naming the file', () => {
    expect(() => parseTestResults('PASS src/a.test.ts', 'out.txt')).toThrow(/^out\.txt: not a Vitest\/Jest JSON report or JUnit XML/);
    expect(() => parseTestResults('{"numTests": 1}', 'r.json')).toThrow(/no "testResults" array/);
    expect(() => parseTestResults('{ nope', 'r.json')).toThrow(/^r\.json: invalid JSON/);
  });
});

describe('toShadowRun', () => {
  it('maps absolute, relative and file:// paths into the repo and drops files outside it', () => {
    const { repo } = TempRepo.from(new Map([['packages/app/src/a.test.ts', 'export {};\n']]));
    try {
      const pkg = join(repo.dir, 'packages', 'app');
      const run = toShadowRun(
        [
          {
            outcomes: [
              { file: join(pkg, 'src', 'a.test.ts'), status: 'passed' },
              { file: 'src/b.test.ts', status: 'failed' }, // relative to the package the runner ran in; deleted files still map
              { file: pathToFileURL(join(pkg, 'src', 'a.test.ts')).href, status: 'failed' },
              { file: join(tmpdir(), 'elsewhere.test.ts'), status: 'failed' },
              { file: join(tmpdir(), 'elsewhere2.test.ts'), status: 'passed' },
            ],
            unattributedFailures: 2,
          },
        ],
        repo.dir,
        pkg,
      );
      expect(run.outcomes).toEqual([
        { path: 'packages/app/src/a.test.ts', status: 'passed' },
        { path: 'packages/app/src/b.test.ts', status: 'failed' },
        { path: 'packages/app/src/a.test.ts', status: 'failed' },
      ]);
      expect(run.unattributedFailures).toBe(3); // 2 + the failing file outside the repo
    } finally {
      repo.dispose();
    }
  });

  it('maps paths written through a different spelling of the repo folder (junction / 8.3 short name)', () => {
    const { repo } = TempRepo.from(new Map([['src/a.test.ts', 'export {};\n']]));
    const alias = mkdtempSync(join(tmpdir(), 'depwave-alias-'));
    const link = join(alias, 'repo-link');
    try {
      symlinkSync(repo.dir, link, 'junction');
      const run = toShadowRun([{ outcomes: [{ file: join(link, 'src', 'a.test.ts'), status: 'failed' }], unattributedFailures: 0 }], repo.dir, repo.dir);
      expect(run.outcomes).toEqual([{ path: 'src/a.test.ts', status: 'failed' }]);
    } finally {
      rmSync(alias, { recursive: true, force: true });
      repo.dispose();
    }
  });
});
