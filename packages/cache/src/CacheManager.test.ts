import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Confidence, SNAPSHOT_FORMAT, type FileFacts, type GraphSnapshot, type ResolutionResult } from '@depwave/core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CacheManager, SCHEMA_VERSION } from './CacheManager.js';

let dir: string;
let dbPath: string;
const open: CacheManager[] = [];
const cache = () => {
  const c = new CacheManager(dbPath);
  open.push(c);
  return c;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'depwave-cache-'));
  dbPath = join(dir, '.depwave', 'cache.db');
});
afterEach(() => {
  open.splice(0).forEach((c) => c.close());
  rmSync(dir, { recursive: true, force: true });
});

const facts = (contentHash: string, parserVersion = 'ts-1'): FileFacts => ({
  path: `src/${contentHash}.ts`,
  language: 'typescript',
  contentHash,
  parserVersion,
  imports: [{ kind: 'static', specifier: './x', bindings: [{ imported: 'x', local: 'x' }], loc: { line: 1, col: 1 } }],
  exports: [],
  symbols: [],
  references: [],
  hasSideEffects: false,
  parseErrors: 0,
});

const resolution = (path: string, probed: string[]): ResolutionResult => ({ kind: 'file', path, probed });

const snapshot = (commit: string, configHash = 'v1'): GraphSnapshot => ({
  formatVersion: SNAPSHOT_FORMAT,
  commit,
  configHash,
  workspace: { tools: ['pnpm'], packages: [{ name: 'a', root: 'a', manifestPath: 'a/package.json', dependencies: [] }] },
  nodes: [{ id: 'file:a/x.ts', kind: 'file', path: 'a/x.ts', contentHash: 'h', isTest: false, hasSideEffects: false, packageId: 'pkg:a' }],
  edges: [{ from: 'file:a/y.ts', to: 'file:a/x.ts', kind: 'IMPORTS', confidence: Confidence.certain, ownerFile: 'file:a/y.ts' }],
  wildcards: [['pkg:a', ['file:a/r.ts']]],
  unresolved: [{ from: 'a/y.ts', specifier: './gone', reason: 'not-found' }],
});

describe('connection', () => {
  it('opens lazily, then creates the directory with a git-ignoring .gitignore', () => {
    const c = cache();
    expect(existsSync(dbPath)).toBe(false);
    c.stats();
    expect(existsSync(dbPath)).toBe(true);
    expect(readFileSync(join(dir, '.depwave', '.gitignore'), 'utf8')).toMatch(/^\*$/m);
  });

  it('runs in WAL mode with the current schema version', () => {
    cache().stats();
    const raw = new Database(dbPath, { readonly: true });
    try {
      expect(raw.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(raw.prepare("SELECT value FROM meta WHERE key = 'schema'").pluck().get()).toBe(String(SCHEMA_VERSION));
    } finally {
      raw.close();
    }
  });

  it('persists across instances (and processes)', () => {
    const first = cache();
    first.putFacts([facts('a')]);
    first.close();
    expect(cache().getFacts({ contentHash: 'a', language: 'typescript', parserVersion: 'ts-1' })).toEqual(facts('a'));
  });

  it('two connections share one file: a write from one is visible to the other', () => {
    const writer = cache();
    const reader = cache();
    reader.stats(); // open both before writing
    writer.putFacts([facts('shared')]);
    expect(reader.getFacts({ contentHash: 'shared', language: 'typescript', parserVersion: 'ts-1' })).toBeDefined();
  });

  it('rebuilds a database from another schema version instead of misreading it', () => {
    const c = cache();
    c.putFacts([facts('old')]);
    c.close();
    const raw = new Database(dbPath);
    raw.prepare("UPDATE meta SET value = '999' WHERE key = 'schema'").run();
    raw.close();

    const reopened = cache();
    expect(reopened.stats().facts).toBe(0);
    reopened.putFacts([facts('new')]);
    expect(reopened.stats().facts).toBe(1);
  });

  it('recovers from a corrupt file by starting fresh', () => {
    cache().stats();
    open.splice(0).forEach((c) => c.close());
    writeFileSync(dbPath, 'this is not a sqlite database'.repeat(200));
    const c = cache();
    expect(c.stats().facts).toBe(0);
    c.putFacts([facts('after')]);
    expect(c.stats().facts).toBe(1);
  });
});

describe('L1 facts', () => {
  it('round-trips and keys on content hash, language and parser version', () => {
    const c = cache();
    c.putFacts([facts('a'), facts('b')]);
    expect(c.getFacts({ contentHash: 'a', language: 'typescript', parserVersion: 'ts-1' })).toEqual(facts('a'));
    expect(c.getFacts({ contentHash: 'a', language: 'typescript', parserVersion: 'ts-2' })).toBeUndefined(); // parser upgrade = miss
    expect(c.getFacts({ contentHash: 'a', language: 'tsx', parserVersion: 'ts-1' })).toBeUndefined();
    expect(c.getFacts({ contentHash: 'zzz', language: 'typescript', parserVersion: 'ts-1' })).toBeUndefined();
  });

  it('writes a batch atomically: a failure mid-batch stores nothing', () => {
    const c = cache();
    const poisoned = { ...facts('bad'), hasSideEffects: 1n } as unknown as FileFacts; // BigInt: JSON.stringify throws
    expect(() => c.putFacts([facts('good-1'), poisoned, facts('good-2')])).toThrow();
    expect(c.stats().facts).toBe(0);
  });
});

describe('L2 resolutions', () => {
  const key = (fromDir: string, specifier = './x', configHash = 'cfg') => ({ fromDir, specifier, configHash });

  it('round-trips and keys on config hash', () => {
    const c = cache();
    c.putResolution(key('src'), resolution('src/x.ts', ['src/x', 'src/x.ts']));
    expect(c.getResolution(key('src'))).toEqual(resolution('src/x.ts', ['src/x', 'src/x.ts']));
    expect(c.getResolution(key('src', './x', 'other-config'))).toBeUndefined();
  });

  it('invalidation by probed path drops exactly the resolutions that checked it', () => {
    const c = cache();
    c.putResolution(key('src/features', '../config'), resolution('src/config/index.ts', ['src/config', 'src/config.ts', 'src/config/index.ts']));
    c.putResolution(key('src/features', '../utils'), resolution('src/utils.ts', ['src/utils', 'src/utils.ts']));
    c.putResolution(key('lib', './config'), resolution('lib/config.ts', ['lib/config', 'lib/config.ts']));

    expect(c.invalidateResolutionsProbing(['src/config.ts'])).toEqual(['src/features']); // the new shadowing file
    expect(c.getResolution(key('src/features', '../config'))).toBeUndefined();
    expect(c.getResolution(key('src/features', '../utils'))).toBeDefined();
    expect(c.getResolution(key('lib', './config'))).toBeDefined();
    expect(c.invalidateResolutionsProbing(['nothing/probed/this.ts'])).toEqual([]);
  });

  it('replacing a resolution replaces its probe set', () => {
    const c = cache();
    c.putResolution(key('src'), resolution('src/x.ts', ['src/old-probe.ts']));
    c.putResolution(key('src'), resolution('src/x.ts', ['src/new-probe.ts']));
    expect(c.invalidateResolutionsProbing(['src/old-probe.ts'])).toEqual([]);
    expect(c.invalidateResolutionsProbing(['src/new-probe.ts'])).toEqual(['src']);
  });

  it('handles invalidation batches beyond SQLite parameter limits', () => {
    const c = cache();
    c.putResolution(key('deep'), resolution('deep/x.ts', ['deep/needle.ts']));
    const paths = Array.from({ length: 2_000 }, (_, i) => `noise/${i}.ts`).concat('deep/needle.ts');
    expect(c.invalidateResolutionsProbing(paths)).toEqual(['deep']);
  });
});

describe('L3 snapshots', () => {
  it('round-trips a full snapshot (gzipped) keyed on commit and analysis version', () => {
    const c = cache();
    c.saveSnapshot(snapshot('abc'));
    expect(c.loadSnapshot('abc', 'v1')).toEqual(snapshot('abc'));
    expect(c.loadSnapshot('abc', 'v2')).toBeUndefined();
    expect(c.loadSnapshot('def', 'v1')).toBeUndefined();
  });
});

describe('stats and clear', () => {
  it('counts every layer, reports size on disk, and clears everything', () => {
    const c = cache();
    c.putFacts([facts('a'), facts('b')]);
    c.putResolution({ fromDir: 'src', specifier: './x', configHash: 'c' }, resolution('src/x.ts', ['src/x.ts']));
    c.saveSnapshot(snapshot('abc'));
    expect(c.stats()).toMatchObject({ path: dbPath, facts: 2, resolutions: 1, snapshots: 1 });
    expect(c.stats().bytes).toBeGreaterThan(0);

    c.clear();
    expect(c.stats()).toMatchObject({ facts: 0, resolutions: 0, snapshots: 0 });
    expect(c.invalidateResolutionsProbing(['src/x.ts'])).toEqual([]); // probes went too
  });
});
