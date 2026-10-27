import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createCli, VERSION } from './cli.js';
import { TempRepo } from '../../../test/support/tempRepo.js';
import { EXIT_FAILURE } from './commands/ImpactCommand.js';
import { EXIT_MISSED } from './commands/ShadowCommand.js';
import { repoRelative } from './commands/WhyCommand.js';

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

describe('depwave CLI', () => {
  it('prints its version', async () => {
    const { code, stdout } = await run(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(VERSION);
  });

  it('documents the impact command in --help', async () => {
    const { stdout } = await run(['--help']);
    expect(stdout).toContain('depwave impact');
  });

  it('fails with one readable line (no stack trace) outside a git repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'depwave-not-a-repo-'));
    try {
      const { code, stderr } = await run(['impact', '--cwd', dir]);
      expect(code).toBe(EXIT_FAILURE);
      expect(stderr).toMatch(/^depwave: git rev-parse --show-toplevel failed .*not a git repository/i);
      expect(stderr.trim().split('\n')).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unknown output formats', async () => {
    const { code, stdout } = await run(['impact', '--format', 'xml']);
    expect(code).toBe(1);
    expect(stdout).toMatch(/format/i);
  });
});

describe('depwave cache', () => {
  it('stats reports what impact stored; clear empties it', async () => {
    const { repo, commit: base } = TempRepo.from(new Map([['package.json', '{ "name": "demo" }\n'], ['src/a.ts', 'export const a = 1;\n'], ['src/a.test.ts', "import { a } from './a';\n"]]));
    try {
      repo.write('src/a.ts', 'export const a = 2;\n');
      const head = repo.commit('change a');
      expect((await run(['impact', '--cwd', repo.dir, '--base', base, '--head', head])).code).toBe(0);

      const stats = await run(['cache', 'stats', '--cwd', repo.dir]);
      expect(stats.code).toBe(0);
      expect(stats.stdout).toMatch(/facts: +3 file\(s\)/); // a.ts at both commits + a.test.ts
      expect(stats.stdout).toMatch(/snapshots: +2 commit\(s\)/);

      const cleared = await run(['cache', 'clear', '--cwd', repo.dir]);
      expect(cleared.stdout).toMatch(/^cleared 3 facts, 0 resolutions, 2 snapshots/);
      expect((await run(['cache', 'stats', '--cwd', repo.dir])).stdout).toMatch(/facts: +0 file/);
    } finally {
      repo.dispose();
    }
  });

  it('fails with one readable line outside a git repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'depwave-not-a-repo-'));
    try {
      const { code, stderr } = await run(['cache', 'stats', '--cwd', dir]);
      expect(code).toBe(EXIT_FAILURE);
      expect(stderr).toMatch(/^depwave: .*not a git repository/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('repoRelative (depwave why target paths)', () => {
  it('maps a path typed from a subdirectory, an absolute path, or a repo-relative path to the same file', () => {
    const { repo } = TempRepo.from(new Map([['packages/app/src/a.test.ts', 'export {};\n']]));
    try {
      const root = repo.dir;
      expect(repoRelative('src/a.test.ts', join(root, 'packages', 'app'), root)).toBe('packages/app/src/a.test.ts');
      expect(repoRelative(join(root, 'packages', 'app', 'src', 'a.test.ts'), root, root)).toBe('packages/app/src/a.test.ts');
      expect(repoRelative('packages/app/src/a.test.ts', join(root, 'packages'), root)).toBe('packages/app/src/a.test.ts'); // not under cwd: repo-relative
    } finally {
      repo.dispose();
    }
  });

  it('works when the cwd and the repo root are different spellings of one folder (junction / 8.3 short name)', () => {
    // Regression: Windows CI runners spell temp dirs as C:\Users\RUNNER~1\…, while git reports the long form.
    const { repo } = TempRepo.from(new Map([['src/a.test.ts', 'export {};\n']]));
    const alias = mkdtempSync(join(tmpdir(), 'depwave-alias-'));
    const link = join(alias, 'repo-link');
    try {
      symlinkSync(repo.dir, link, 'junction');
      expect(repoRelative('src/a.test.ts', link, repo.dir)).toBe('src/a.test.ts');
      expect(repoRelative('a.test.ts', join(link, 'src'), repo.dir)).toBe('src/a.test.ts');
    } finally {
      rmSync(alias, { recursive: true, force: true });
      repo.dispose();
    }
  });
});

describe('depwave shadow', () => {
  const results = (dir: string, failing: string[], passing: string[]) => {
    const file = join(dir, 'results.json');
    const entry = (path: string, status: string) => ({ name: join(dir, path), status, assertionResults: [{ status }] });
    writeFileSync(file, JSON.stringify({ testResults: [...failing.map((p) => entry(p, 'failed')), ...passing.map((p) => entry(p, 'passed'))] }));
    return file;
  };

  it('exits 0 when every failing test was selected, and 3 naming the test when one was missed', async () => {
    const { repo, commit: base } = TempRepo.from(
      new Map([
        ['package.json', '{ "name": "demo" }\n'],
        ['src/a.ts', 'export const a = 1;\n'],
        ['src/b.ts', 'export const b = 1;\n'],
        ['src/a.test.ts', "import { a } from './a';\nconsole.log(a);\n"],
        ['src/b.test.ts', "import { b } from './b';\nconsole.log(b);\n"],
      ]),
    );
    try {
      repo.write('src/a.ts', 'export const a = 2;\n');
      const head = repo.commit('change a');
      const args = ['shadow', '--cwd', repo.dir, '--base', base, '--head', head, '--no-cache'];

      const caught = await run([...args, '--results', results(repo.dir, ['src/a.test.ts'], ['src/b.test.ts'])]);
      expect(caught.code).toBe(0);
      expect(caught.stdout).toContain('all 1 failing test file selected ✔');
      expect(caught.stdout).toContain('a selective run would have run 1 of 2 test files (50% skipped)');

      const missed = await run([...args, '--results', results(repo.dir, ['src/b.test.ts'], ['src/a.test.ts']), '--format', 'json']);
      expect(missed.code).toBe(EXIT_MISSED);
      expect(JSON.parse(missed.stdout).shadow).toMatchObject({ verdict: 'missed', missed: ['src/b.test.ts'], caught: [], selected: 1, ran: 2 });

      const md = await run([...args, '--results', results(repo.dir, ['src/b.test.ts'], []), '--format', 'markdown']);
      expect(md.stdout).toContain('#### 🕵️ Shadow check: 1 failing test file NOT selected ❌');
      expect(md.stdout).toContain('> - `src/b.test.ts`');
    } finally {
      repo.dispose();
    }
  });

  it('fails fast on a results file with no tests, before analyzing anything', async () => {
    const { repo } = TempRepo.from(new Map([['package.json', '{ "name": "demo" }\n']]));
    try {
      const file = join(repo.dir, 'empty.json');
      writeFileSync(file, '{ "testResults": [] }');
      const { code, stderr } = await run(['shadow', '--cwd', repo.dir, '--base', 'does-not-exist', '--results', file]);
      expect(code).toBe(EXIT_FAILURE);
      expect(stderr).toMatch(/^depwave: no test files found in .*empty\.json/);
    } finally {
      repo.dispose();
    }
  });
});
