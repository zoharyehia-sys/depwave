import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WORKTREE, type FileChange } from '@depwave/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TempRepo } from '../../../test/support/tempRepo.js';
import { GitError, GitService } from './GitService.js';

const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n';
const byPath = (changes: FileChange[]) => [...changes].sort((a, b) => a.path.localeCompare(b.path));

describe('GitService (against a real repo)', () => {
  const repo = new TempRepo();
  const service = new GitService(repo.dir);
  let c1: string;
  let c2: string;

  beforeAll(() => {
    repo
      .write('src/a.ts', lines(10))
      .write('src/b.ts', 'export const b = 1;\n')
      .write('src/c.ts', lines(30, 'renamed'))
      .write('src/שלום.ts', 'export const shalom = 1;\n')
      .write('.gitignore', 'ignored.log\n');
    c1 = repo.commit('c1');

    // c2: modify a (line 3 changed, insertion after 7, line 9 deleted), delete b, rename c → d with one edit, add e.
    const a = lines(10).split('\n');
    a[2] = 'CHANGED 3';
    a.splice(7, 0, 'INSERTED');
    a.splice(9, 1);
    repo.write('src/a.ts', a.join('\n')).remove('src/b.ts').remove('src/c.ts');
    repo.write('src/d.ts', lines(30, 'renamed').replace('renamed 15', 'edited 15')).write('src/e.ts', 'export const e = 1;\n');
    c2 = repo.commit('c2');
  });

  afterAll(() => repo.dispose());

  describe('diff between commits', () => {
    it('reports A, M, D and R with oids', async () => {
      expect(byPath(await service.diff(c1, c2))).toEqual([
        { status: 'M', path: 'src/a.ts', oldOid: repo.oid(c1, 'src/a.ts'), newOid: repo.oid(c2, 'src/a.ts') },
        { status: 'D', path: 'src/b.ts', oldOid: repo.oid(c1, 'src/b.ts') },
        {
          status: 'R',
          path: 'src/d.ts',
          oldPath: 'src/c.ts',
          oldOid: repo.oid(c1, 'src/c.ts'),
          newOid: repo.oid(c2, 'src/d.ts'),
        },
        { status: 'A', path: 'src/e.ts', newOid: repo.oid(c2, 'src/e.ts') },
      ]);
    });

    it('returns nothing for identical revisions', async () => {
      expect(await service.diff(c2, c2)).toEqual([]);
    });
  });

  describe('hunks', () => {
    it('reports exact zero-context ranges for edits, insertions and deletions', async () => {
      expect(await service.hunks(c1, c2, 'src/a.ts')).toEqual([
        { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 },
        { oldStart: 7, oldLines: 0, newStart: 8, newLines: 1 },
        { oldStart: 9, oldLines: 1, newStart: 9, newLines: 0 },
      ]);
    });

    it('limits a renamed file to its real edits when oldPath is given', async () => {
      expect(await service.hunks(c1, c2, 'src/d.ts', 'src/c.ts')).toEqual([
        { oldStart: 15, oldLines: 1, newStart: 15, newLines: 1 },
      ]);
    });
  });

  describe('listTracked / readBlob at a commit', () => {
    it('lists every blob with its oid, including unicode paths', async () => {
      const tracked = await service.listTracked(c1);
      expect(tracked.map((f) => f.path).sort()).toEqual(['.gitignore', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/שלום.ts']);
      expect(tracked.find((f) => f.path === 'src/שלום.ts')?.oid).toBe(repo.oid(c1, 'src/שלום.ts'));
    });

    it('reads historical content', async () => {
      expect(await service.readBlob(c1, 'src/b.ts')).toBe('export const b = 1;\n');
    });
  });

  it('finds the merge base of diverged branches', async () => {
    repo.git('checkout', '-q', '-b', 'feature', c1);
    repo.write('src/feature.ts', 'export const f = 1;\n');
    repo.commit('feature work');
    repo.git('checkout', '-q', 'main');

    expect(await service.mergeBase('main', 'feature')).toBe(c1);
    expect(await service.mergeBase('feature', WORKTREE)).toBe(c1);
  });

  it('keeps the error message to git\'s one fatal line; the full stderr stays available', () => {
    const error = new GitError(['rev-parse'], 128, 'fatal: not a git repository (or any parent up to mount point /)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n');
    expect(error.message).toBe('git rev-parse failed (exit 128): fatal: not a git repository (or any parent up to mount point /)');
    expect(error.stderr).toContain('Stopping at filesystem boundary');
  });

  it('resolves refs to full commit SHAs and leaves WORKTREE alone', async () => {
    expect(await service.resolveRevision('main')).toMatch(/^[0-9a-f]{40}$/);
    expect(await service.resolveRevision(c1.slice(0, 8))).toBe(c1);
    expect(await service.resolveRevision(WORKTREE)).toBe(WORKTREE);
    await expect(service.resolveRevision('no-such-ref')).rejects.toBeInstanceOf(GitError);
  });

  it('resolves the repo root from a subdirectory, so paths stay root-relative', async () => {
    const nested = new GitService(join(repo.dir, 'src'));
    expect((await nested.diff(c1, c2)).map((c) => c.path)).toContain('src/a.ts');
  });

  it('wraps non-zero exits in GitError with the command, exit code and decoded stderr', async () => {
    const error = await service.diff('no-such-rev', c2).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    const { args, exitCode, stderr, message } = error as GitError;
    expect(args.slice(0, 2)).toEqual(['diff', '--raw']);
    expect(args).toContain('no-such-rev');
    expect(exitCode).toBe(128);
    expect(typeof stderr).toBe('string');
    expect(stderr).toMatch(/no-such-rev/);
    expect(message).toMatch(/^git diff --raw .* failed \(exit 128\): /);
  });

  describe('readBlobs (batched)', () => {
    it('reads many files in one call, skipping missing ones and keeping multi-byte content intact', async () => {
      const blobs = await service.readBlobs(c1, ['src/b.ts', 'src/שלום.ts', 'src/nope.ts', 'src/c.ts']);
      expect([...blobs.keys()].sort()).toEqual(['src/b.ts', 'src/c.ts', 'src/שלום.ts']);
      expect(blobs.get('src/b.ts')).toBe('export const b = 1;\n');
      expect(blobs.get('src/שלום.ts')).toBe('export const shalom = 1;\n');
      expect(blobs.get('src/c.ts')).toBe(lines(30, 'renamed'));
    });

    it('returns an empty map for no paths without spawning git', async () => {
      expect(await new GitService('/definitely/not/a/repo').readBlobs(c1, [])).toEqual(new Map());
    });
  });

  it('rejects WORKTREE as a diff base', async () => {
    await expect(service.diff(WORKTREE, c2)).rejects.toThrow(/base must be a commit/);
  });

  describe('working tree', () => {
    beforeAll(() => {
      repo.write('src/a.ts', 'dirty\n'); // unstaged edit
      repo.write('src/staged.ts', 'staged\n');
      repo.git('add', 'src/staged.ts'); // staged add
      repo.write('src/untracked.ts', 'untracked\n');
      repo.write('ignored.log', 'nope\n');
      repo.remove('src/e.ts'); // deleted on disk, still in index
    });

    it('includes unstaged, staged, untracked and deleted files, but not ignored ones', async () => {
      const changes = byPath(await service.diff(c2, WORKTREE));
      expect(changes.map(({ status, path }) => ({ status, path }))).toEqual([
        { status: 'M', path: 'src/a.ts' },
        { status: 'D', path: 'src/e.ts' },
        { status: 'A', path: 'src/staged.ts' },
        { status: 'A', path: 'src/untracked.ts' },
      ]);
    });

    it('hashes dirty and untracked files so oids match their current content', async () => {
      const tracked = new Map((await service.listTracked(WORKTREE)).map((f) => [f.path, f.oid]));
      const hashOf = (path: string) => repo.git('hash-object', path).trim();

      expect(tracked.get('src/a.ts')).toBe(hashOf('src/a.ts'));
      expect(tracked.get('src/untracked.ts')).toBe(hashOf('src/untracked.ts'));
      expect(tracked.get('src/staged.ts')).toBe(hashOf('src/staged.ts'));
      expect(tracked.get('src/d.ts')).toBe(repo.oid(c2, 'src/d.ts')); // clean file: index oid
      expect(tracked.has('src/e.ts')).toBe(false);
      expect(tracked.has('ignored.log')).toBe(false);
    });

    it('reads current file content', async () => {
      expect(await service.readBlob(WORKTREE, 'src/a.ts')).toBe('dirty\n');
      const blobs = await service.readBlobs(WORKTREE, ['src/a.ts', 'src/e.ts']);
      expect(Object.fromEntries(blobs)).toEqual({ 'src/a.ts': 'dirty\n' });
    });

    it('OID parity: a working-tree oid equals the blob oid once that content is committed', async () => {
      const parity = new TempRepo();
      try {
        parity.write('base.ts', 'export {};\n');
        parity.commit('base');
        // Multi-byte content and no trailing newline: byte-exact hashing matters.
        parity.write('src/parity.ts', 'export const שלום = "✓";').write('src/edited.ts', 'v1\n');
        parity.commit('v1');
        parity.write('src/edited.ts', 'v2\n');

        const git = new GitService(parity.dir);
        const before = new Map((await git.listTracked(WORKTREE)).map((f) => [f.path, f.oid]));
        const commit = parity.commit('v2');

        expect(before.get('src/edited.ts')).toBe(parity.oid(commit, 'src/edited.ts')); // dirty → hash-object
        expect(before.get('src/parity.ts')).toBe(parity.oid(commit, 'src/parity.ts')); // clean → index
        const after = new Map((await git.listTracked(commit)).map((f) => [f.path, f.oid]));
        expect(after).toEqual(before);
      } finally {
        parity.dispose();
      }
    });

    it('reports hunks for unstaged edits', async () => {
      expect(await service.hunks(c2, WORKTREE, 'src/a.ts')).toEqual([{ oldStart: 1, oldLines: 10, newStart: 1, newLines: 1 }]);
    });
  });
});

describe('GitService merge-base hints (common first-run failures)', () => {
  it('names a base revision that does not exist', async () => {
    const repo = new TempRepo();
    try {
      repo.write('a.ts', 'export {};\n');
      repo.commit('init');
      const error = await new GitService(repo.dir).mergeBase('origin/main', 'HEAD').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitError);
      expect((error as GitError).message).toMatch(/fatal: revision 'origin\/main' not found\. Fetch it first .* or pass another --base\.$/);
    } finally {
      repo.dispose();
    }
  });

  it('explains a shallow clone whose history does not reach the merge base', async () => {
    const origin = new TempRepo();
    const clone = mkdtempSync(join(tmpdir(), 'depwave-shallow-'));
    try {
      origin.write('a.ts', 'export const a = 1;\n');
      origin.commit('base');
      origin.git('checkout', '-q', '-b', 'feature');
      origin.write('a.ts', 'export const a = 2;\n');
      origin.commit('feature work');
      origin.git('checkout', '-q', 'main');
      origin.write('b.ts', 'export const b = 1;\n');
      origin.commit('main moves on');
      // Like CI's default checkout: one commit of each branch, no shared history.
      execFileSync('git', ['clone', '-q', '--depth', '1', '--no-single-branch', pathToFileURL(origin.dir).href, clone]);
      const error = await new GitService(clone).mergeBase('origin/main', 'origin/feature').catch((e: unknown) => e);
      expect((error as GitError).message).toMatch(/no merge base .* in this shallow clone\. Fetch full history \(actions\/checkout with fetch-depth: 0/);
    } finally {
      rmSync(clone, { recursive: true, force: true });
      origin.dispose();
    }
  });
});
