import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCli } from '../cli.js';
import { EXIT_FAILURE } from './ImpactCommand.js';

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out: string[] = [];
  const err: string[] = [];
  stdout.on('data', (chunk: Buffer) => out.push(chunk.toString()));
  stderr.on('data', (chunk: Buffer) => err.push(chunk.toString()));
  const code = await createCli().run(args, { stdout, stderr });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

const sha = (n: number) => String(n).padStart(40, 'a');
/** What `depwave shadow --format json` writes, before `basis` existed (older CI artifacts look like this). */
const shadowJson = (head: string, shadow: Record<string, unknown>) =>
  JSON.stringify({
    base: sha(0),
    head,
    granularity: 'symbol',
    shadow: { verdict: 'sound', runAll: false, selected: 2, ran: 8, partial: false, totalTests: 8, notRun: [], failed: [], caught: [], missed: [], unrecognized: [], unattributedFailures: 0, ...shadow },
  });

describe('depwave shadow history', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'depwave-history-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (path: string, content: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  };

  it('reads CI artifact folders recursively, skips other JSON, and merges one commit across OSes', async () => {
    write('run-1/depwave-impact-ubuntu-latest/depwave-shadow.json', shadowJson(sha(1), { failed: ['a.test.ts'], caught: ['a.test.ts'] }));
    write('run-1/depwave-impact-windows-latest/depwave-shadow.json', shadowJson(sha(1), { failed: ['a.test.ts'], caught: ['a.test.ts'] }));
    write('run-1/depwave-impact-ubuntu-latest/depwave-impact.json', JSON.stringify({ plan: {}, report: {} }));
    write('run-2/depwave-shadow.json', shadowJson(sha(2), { verdict: 'missed', failed: ['b.test.ts'], missed: ['b.test.ts'] }));
    write('run-3/depwave-shadow.json', shadowJson(sha(3), { runAll: true, failed: ['c.test.ts'], caught: ['c.test.ts'] }));

    const { code, stdout } = await run(['shadow', 'history', '--input', dir]);
    // 4,740 checked independently: with one miss, n = 4,742 is the first total where P(X >= n - 1 | n, 0.999) <= 0.05.
    expect(code).toBe(0);
    expect(stdout).toBe(
      [
        'depwave shadow history: 2 failures observed, 1 missed (recall 50.00%) ✘',
        '  runs: 3 (2 tested the selection, 1 selected everything)',
        '  evidence: at 95.00% confidence, recall is at least 2.53%. 4,740 more failures, none missed, would show recall ≥ 99.90%',
        '  savings: a selective run would have skipped 50% of test files on average',
        '  missed:',
        `    ${sha(2).slice(0, 12)} b.test.ts`,
        '  Each is a flaky test or a dependency depwave did not see. Check with `depwave why <test> --base <base> --head <commit>` (--format json has both).',
        '',
      ].join('\n'),
    );

    const json = JSON.parse((await run(['shadow', 'history', '--input', dir, '--format', 'json', '--target', '0.99'])).stdout);
    expect(json.history).toMatchObject({ records: 4, runs: 3, failures: 2, caught: 1, target: 0.99, confidence: 0.95 });
    expect(json.history.missed).toEqual([{ base: sha(0), head: sha(2), path: 'b.test.ts', discovery: false }]);
  });

  it('fails on a shadow result it cannot read instead of dropping a run', async () => {
    write('ok.json', shadowJson(sha(1), {}));
    write('broken.json', JSON.stringify({ base: sha(0), head: sha(2), shadow: { verdict: 'great' } }));
    const { code, stderr } = await run(['shadow', 'history', '--input', dir]);
    expect(code).toBe(EXIT_FAILURE);
    expect(stderr).toMatch(/broken\.json: not a depwave shadow result this version can read/);

    write('broken.json', '{ "shadow": ');
    expect((await run(['shadow', 'history', '--input', dir])).stderr).toMatch(/broken\.json: invalid JSON/);
  });

  it('names empty files instead of failing: CI writes them when `depwave shadow` itself failed', async () => {
    write('ok.json', shadowJson(sha(1), {}));
    write('crashed/depwave-shadow.json', '');
    const { code, stdout } = await run(['shadow', 'history', '--input', dir]);
    expect(code).toBe(0);
    expect(stdout).toContain('  ⚠ 1 empty result file skipped: depwave shadow failed in those runs, so a miss there went unseen\n');
    expect(stdout).toContain(join('crashed', 'depwave-shadow.json'));
  });

  it('says so when there is nothing to add up, and rejects a target that is not a probability', async () => {
    write('impact.json', JSON.stringify({ plan: {} }));
    expect((await run(['shadow', 'history', '--input', dir])).stderr).toMatch(/^depwave: no depwave shadow results in /);
    write('s.json', shadowJson(sha(1), {}));
    expect((await run(['shadow', 'history', '--input', dir, '--granularity', 'file'])).stderr).toMatch(/none of the 1 shadow result\(s\) is at file granularity/);
    expect((await run(['shadow', 'history', '--input', dir, '--target', '1'])).code).not.toBe(0);
  });

  it('explains a missing --input or input path in one line', async () => {
    const missingFlag = await run(['shadow', 'history']);
    expect(missingFlag.code).toBe(EXIT_FAILURE);
    expect(missingFlag.stderr).toBe('depwave: shadow history needs --input <path>: a `depwave shadow --format json` file, or a directory of them\n');
    const missingPath = await run(['shadow', 'history', '--input', join(dir, 'no-such-runs')]);
    expect(missingPath.code).toBe(EXIT_FAILURE);
    expect(missingPath.stderr).toMatch(/^depwave: --input .*no-such-runs: no such file or directory\n$/);
  });

  it('names option values in its help', async () => {
    const help = (await run(['shadow', 'history', '--help'])).stdout;
    expect(help).toContain('--input <path>');
    expect(help).toContain('--confidence <p>');
    expect(help).not.toContain('#0');
  });

  it('does not collide with `depwave shadow`, which still needs --results', async () => {
    expect((await run(['shadow', 'history', '--help'])).stdout).toContain('depwave shadow history');
    expect((await run(['shadow', '--help'])).stdout).toContain('--results');
  });
});
