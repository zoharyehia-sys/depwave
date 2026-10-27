import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createCli, VERSION } from './cli.js';
import { TempRepo } from '../../../test/support/tempRepo.js';
import { EXIT_FAILURE } from './commands/ImpactCommand.js';

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
