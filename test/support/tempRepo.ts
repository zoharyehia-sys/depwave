import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Throwaway git repo driven by the real git binary. Call `dispose()` in afterAll. */
export class TempRepo {
  readonly dir = mkdtempSync(join(tmpdir(), 'ripple-'));

  constructor() {
    this.git('init', '-q', '-b', 'main');
    for (const [key, value] of [
      ['user.name', 'Ripple Test'],
      ['user.email', 'test@example.com'],
      ['commit.gpgsign', 'false'],
      ['core.autocrlf', 'false'],
    ] as const) {
      this.git('config', key, value);
    }
  }

  /** Repo seeded with an in-memory tree (e.g. a loaded fixture) and committed. */
  static from(files: ReadonlyMap<string, string>, message = 'initial'): { repo: TempRepo; commit: string } {
    const repo = new TempRepo();
    for (const [path, content] of files) repo.write(path, content);
    return { repo, commit: repo.commit(message) };
  }

  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.dir, encoding: 'utf8' });
  }

  write(path: string, content: string): this {
    mkdirSync(dirname(join(this.dir, path)), { recursive: true });
    writeFileSync(join(this.dir, path), content);
    return this;
  }

  remove(path: string): this {
    unlinkSync(join(this.dir, path));
    return this;
  }

  commit(message: string): string {
    this.git('add', '-A');
    this.git('commit', '-q', '--allow-empty', '-m', message);
    return this.git('rev-parse', 'HEAD').trim();
  }

  oid(rev: string, path: string): string {
    return this.git('rev-parse', `${rev}:${path}`).trim();
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
