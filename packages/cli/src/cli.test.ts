import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createCli, VERSION } from './cli.js';
import { EXIT_NOT_IMPLEMENTED } from './commands/ImpactCommand.js';

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

  it('reports `impact` as not implemented with a dedicated exit code', async () => {
    const { code, stderr } = await run(['impact', '--base', 'main']);
    expect(code).toBe(EXIT_NOT_IMPLEMENTED);
    expect(stderr).toMatch(/not implemented yet \(planned for Phase 1\)/);
  });

  it('rejects unknown output formats', async () => {
    const { code, stdout } = await run(['impact', '--format', 'xml']);
    expect(code).toBe(1);
    expect(stdout).toMatch(/format/i);
  });
});
