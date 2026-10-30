import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WORKTREE, type CommitMessage, type FileChange, type GitPort, type Hunk, type Revision, type TrackedFile } from '@depwave/core';
import { parseCatFileBatch, parseHunks, parseLsFilesStaged, parseLsTree, parsePathList, parseRawDiff } from './parse.js';

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed (exit ${exitCode ?? 'signal'}): ${summarize(stderr)}`);
    this.name = 'GitError';
  }
}

/**
 * One line for the error message: git's `fatal:`/`error:` line if there is one, else the first line. Git may add hints
 * on later lines (e.g. Linux's "Stopping at filesystem boundary…"); the full text stays on GitError.stderr.
 */
function summarize(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[0] ?? '';
}

/** Common flags that shield parsing from user config (external diff tools, colors). */
const DIFF_FLAGS = ['--no-ext-diff', '--no-color', '-M'];

/**
 * Spawns `git` directly with `-z` output: full fidelity, no wrapper-library leaks.
 * Every command runs at the repository root, so paths are root-relative whatever `cwd` was given.
 */
export class GitService implements GitPort {
  private rootDir: Promise<string> | undefined;

  constructor(readonly cwd: string) {}

  /** Absolute path of the repository's top-level directory. */
  root(): Promise<string> {
    this.rootDir ??= run(this.cwd, ['rev-parse', '--show-toplevel']).then((out) => out.toString('utf8').trim());
    return this.rootDir;
  }

  /**
   * The two most common first-run failures get actionable messages instead of raw git output: a base ref that isn't
   * fetched, and a shallow clone (CI's default `fetch-depth: 1`) where the histories don't meet.
   */
  async mergeBase(a: Revision, b: Revision): Promise<string> {
    const args = ['merge-base', commitish(a), commitish(b)];
    try {
      return (await this.git(args)).trim();
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      for (const rev of [a, b]) {
        if (rev !== WORKTREE && !(await this.exists(rev))) {
          throw new GitError(args, error.exitCode, `fatal: revision '${rev}' not found. Fetch it first (e.g. git fetch origin main) or pass another --base.\n${error.stderr}`);
        }
      }
      if ((await this.git(['rev-parse', '--is-shallow-repository'])).trim() === 'true') {
        throw new GitError(args, error.exitCode, `fatal: no merge base between '${a}' and '${b}' in this shallow clone. Fetch full history (actions/checkout with fetch-depth: 0, or git fetch --unshallow).\n${error.stderr}`);
      }
      throw new GitError(args, error.exitCode, `fatal: '${a}' and '${b}' have no common history.\n${error.stderr}`);
    }
  }

  private async exists(rev: Revision): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  async resolveRevision(rev: Revision): Promise<string> {
    if (rev === WORKTREE) return WORKTREE;
    return (await this.git(['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`])).trim();
  }

  async diff(base: Revision, head: Revision): Promise<FileChange[]> {
    assertCommit(base, 'base');
    const range = head === WORKTREE ? [base] : [base, head];
    const changes = parseRawDiff(await this.git(['diff', '--raw', '-z', '--no-abbrev', ...DIFF_FLAGS, ...range, '--']));
    if (head !== WORKTREE) return changes;

    // Untracked files are invisible to `git diff`. A path that was un-indexed (`git rm --cached`) but still
    // exists on disk shows up as both D and untracked: from the analyzer's view it was modified.
    const byPath = new Map(changes.map((c) => [c.path, c]));
    for (const path of await this.untracked()) {
      const existing = byPath.get(path);
      if (existing?.status === 'D') {
        existing.status = 'M';
      } else {
        changes.push({ status: 'A', path });
      }
    }
    return changes;
  }

  async hunks(base: Revision, head: Revision, path: string, oldPath?: string): Promise<Hunk[]> {
    assertCommit(base, 'base');
    const range = head === WORKTREE ? [base] : [base, head];
    const paths = oldPath === undefined ? [path] : [oldPath, path];
    return parseHunks(await this.git(['diff', '-U0', ...DIFF_FLAGS, ...range, '--', ...paths]));
  }

  async commitMessages(base: Revision, head: Revision): Promise<CommitMessage[]> {
    assertCommit(base, 'base');
    const output = await this.git(['log', '--format=%H%x00%B%x00', `${base}..${head === WORKTREE ? 'HEAD' : head}`, '--']);
    const fields = output.split('\0');
    const commits: CommitMessage[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) commits.push({ sha: fields[i]!.trim(), message: fields[i + 1]! });
    return commits;
  }

  async listTracked(rev: Revision): Promise<TrackedFile[]> {
    if (rev !== WORKTREE) return parseLsTree(await this.git(['ls-tree', '-r', '-z', '--full-tree', rev]));

    const [staged, deleted, modified, untracked] = await Promise.all([
      this.git(['ls-files', '-s', '-z']).then(parseLsFilesStaged),
      this.git(['ls-files', '-d', '-z']).then(parsePathList),
      this.git(['ls-files', '-m', '-z']).then(parsePathList),
      this.untracked(),
    ]);

    const gone = new Set(deleted);
    const oids = new Map(staged.filter((f) => !gone.has(f.path)).map((f) => [f.path, f.oid]));
    const dirty = [...new Set([...modified.filter((p) => !gone.has(p)), ...untracked])];
    if (dirty.length > 0) {
      // One oid per line, in input order. Clean/smudge filters apply, so oids match what `git add` would store.
      const hashed = (await this.git(['hash-object', '--stdin-paths'], `${dirty.join('\n')}\n`)).split('\n').filter(Boolean);
      dirty.forEach((path, i) => oids.set(path, hashed[i] as string));
    }
    return [...oids].map(([path, oid]) => ({ path, oid })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async readBlob(rev: Revision, path: string): Promise<string> {
    if (rev === WORKTREE) return readFile(join(await this.root(), path), 'utf8');
    return this.git(['cat-file', 'blob', `${rev}:${path}`]);
  }

  async readBlobs(rev: Revision, paths: readonly string[]): Promise<Map<string, string>> {
    if (paths.length === 0) return new Map();
    if (rev !== WORKTREE) {
      const input = paths.map((p) => `${rev}:${p}\n`).join('');
      return parseCatFileBatch(await run(await this.root(), ['cat-file', '--batch'], input), paths);
    }

    const root = await this.root();
    const blobs = new Map<string, string>();
    await Promise.all(
      paths.map(async (path) => {
        try {
          blobs.set(path, await readFile(join(root, path), 'utf8'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }),
    );
    return blobs;
  }

  private untracked(): Promise<string[]> {
    return this.git(['ls-files', '--others', '--exclude-standard', '-z']).then(parsePathList);
  }

  private async git(args: string[], input?: string): Promise<string> {
    return (await run(await this.root(), args, input)).toString('utf8');
  }
}

const commitish = (rev: Revision): string => (rev === WORKTREE ? 'HEAD' : rev);

function assertCommit(rev: Revision, name: string): void {
  if (rev === WORKTREE) throw new Error(`${name} must be a commit, not ${WORKTREE}`);
}

function run(cwd: string, args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      // Read-only commands must never take index.lock and race the user's own git operations.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new GitError(args, code, Buffer.concat(err).toString('utf8')));
    });
    child.stdin.end(input);
  });
}
