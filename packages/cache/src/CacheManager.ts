import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import type {
  CachePort,
  CacheStats,
  FactsKey,
  FileFacts,
  GraphSnapshot,
  ResolutionKey,
  ResolutionResult,
} from '@depwave/core';

/** Bump on any table change: an older/newer database is dropped and rebuilt (the cache is disposable). */
export const SCHEMA_VERSION = 1;

const SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE facts (
    content_hash TEXT NOT NULL, language TEXT NOT NULL, parser_version TEXT NOT NULL,
    data TEXT NOT NULL, stored_at INTEGER NOT NULL,
    PRIMARY KEY (content_hash, language, parser_version)
  ) WITHOUT ROWID;
  CREATE TABLE resolutions (
    id INTEGER PRIMARY KEY,
    from_dir TEXT NOT NULL, specifier TEXT NOT NULL, config_hash TEXT NOT NULL, data TEXT NOT NULL,
    UNIQUE (from_dir, specifier, config_hash)
  );
  CREATE TABLE resolution_probes (
    resolution_id INTEGER NOT NULL REFERENCES resolutions(id) ON DELETE CASCADE,
    path TEXT NOT NULL
  );
  CREATE INDEX probes_by_path ON resolution_probes(path);
  CREATE INDEX probes_by_resolution ON resolution_probes(resolution_id);
  CREATE TABLE snapshots (
    commit_sha TEXT NOT NULL, config_hash TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (commit_sha, config_hash)
  ) WITHOUT ROWID;
`;

const TABLES = ['resolution_probes', 'resolutions', 'facts', 'snapshots', 'meta'];

/** SQLite's bound-parameter limit is 32766; stay far below it. */
const CHUNK = 500;

type Statements = ReturnType<typeof prepare>;

/**
 * The persistent cache: one SQLite file (default `.depwave/cache.db`), WAL mode, synchronous API.
 *
 *  L1 facts        (content hash, language, parser version) → FileFacts. Content-addressed, so never stale.
 *  L2 resolutions  (importer dir, specifier, resolver config hash) → result + probed paths, indexed by path
 *                  so adding/deleting a file drops exactly the resolutions that checked it.
 *  L3 snapshots    (commit, analysis config) → gzipped graph. Commits are immutable, so never stale.
 *
 * Opens lazily. Every batch write is one transaction: a crash leaves the previous state, never a torn one.
 * A corrupt or foreign-schema file is deleted and rebuilt rather than failing the analysis.
 */
export class CacheManager implements CachePort {
  private db: Database.Database | undefined;
  private statements: Statements | undefined;

  constructor(readonly dbPath: string) {}

  getFacts(key: FactsKey): FileFacts | undefined {
    const row = this.sql().getFacts.get(key.contentHash, key.language, key.parserVersion) as { data: string } | undefined;
    return row && (JSON.parse(row.data) as FileFacts);
  }

  putFacts(facts: readonly FileFacts[]): void {
    if (facts.length === 0) return;
    const { putFacts } = this.sql();
    const now = Date.now();
    this.transaction(() => {
      for (const f of facts) putFacts.run(f.contentHash, f.language, f.parserVersion, JSON.stringify(f), now);
    });
  }

  getResolution(key: ResolutionKey): ResolutionResult | undefined {
    const row = this.sql().getResolution.get(key.fromDir, key.specifier, key.configHash) as { data: string } | undefined;
    return row && (JSON.parse(row.data) as ResolutionResult);
  }

  putResolution(key: ResolutionKey, result: ResolutionResult): void {
    const { putResolution, deleteProbes, putProbe } = this.sql();
    this.transaction(() => {
      const { id } = putResolution.get(key.fromDir, key.specifier, key.configHash, JSON.stringify(result)) as { id: number };
      deleteProbes.run(id);
      for (const path of new Set(result.probed)) putProbe.run(id, path);
    });
  }

  invalidateResolutionsProbing(paths: readonly string[]): string[] {
    const db = this.open();
    const dirs = new Set<string>();
    this.transaction(() => {
      for (let i = 0; i < paths.length; i += CHUNK) {
        const chunk = paths.slice(i, i + CHUNK);
        const marks = chunk.map(() => '?').join(',');
        const rows = db
          .prepare(`DELETE FROM resolutions WHERE id IN (SELECT resolution_id FROM resolution_probes WHERE path IN (${marks})) RETURNING from_dir`)
          .all(...chunk) as Array<{ from_dir: string }>;
        for (const row of rows) dirs.add(row.from_dir);
      }
    });
    return [...dirs].sort();
  }

  loadSnapshot(commit: string, configHash: string): GraphSnapshot | undefined {
    const row = this.sql().getSnapshot.get(commit, configHash) as { data: Buffer } | undefined;
    return row && (JSON.parse(gunzipSync(row.data).toString('utf8')) as GraphSnapshot);
  }

  saveSnapshot(snapshot: GraphSnapshot): void {
    this.sql().putSnapshot.run(snapshot.commit, snapshot.configHash, gzipSync(JSON.stringify(snapshot)), Date.now());
  }

  stats(): CacheStats {
    const row = this.sql().stats.get() as { facts: number; resolutions: number; snapshots: number };
    const size = (path: string) => (existsSync(path) ? statSync(path).size : 0);
    return { path: this.dbPath, ...row, bytes: size(this.dbPath) + size(`${this.dbPath}-wal`) };
  }

  clear(): void {
    const db = this.open();
    this.transaction(() => db.exec('DELETE FROM resolution_probes; DELETE FROM resolutions; DELETE FROM facts; DELETE FROM snapshots;'));
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
    this.statements = undefined;
  }

  // ─── connection ──────────────────────────────────────────────────────────────

  private sql(): Statements {
    this.statements ??= prepare(this.open());
    return this.statements;
  }

  private transaction(work: () => void): void {
    this.open().transaction(work)();
  }

  private open(): Database.Database {
    if (this.db) return this.db;
    ensureCacheDir(dirname(this.dbPath));
    try {
      this.db = connect(this.dbPath);
    } catch (error) {
      if (!isCorruption(error)) throw error;
      removeDatabase(this.dbPath); // disposable: rebuild instead of failing the run
      this.db = connect(this.dbPath);
    }
    return this.db;
  }
}

function connect(path: string): Database.Database {
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL'); // readers never block the writer; crash-safe
    db.pragma('synchronous = NORMAL'); // safe with WAL, much faster than FULL
    db.pragma('busy_timeout = 5000'); // parallel CI jobs sharing a cache wait instead of failing
    db.pragma('foreign_keys = ON');
    if (schemaVersion(db) !== SCHEMA_VERSION) migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function schemaVersion(db: Database.Database): number {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  return hasMeta ? Number(db.prepare("SELECT value FROM meta WHERE key = 'schema'").pluck().get() ?? 0) : 0;
}

/** Fresh tables for this schema version; anything older is simply discarded. */
function migrate(db: Database.Database): void {
  db.transaction(() => {
    for (const table of TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.exec(SCHEMA);
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
  })();
}

function prepare(db: Database.Database) {
  return {
    getFacts: db.prepare('SELECT data FROM facts WHERE content_hash = ? AND language = ? AND parser_version = ?'),
    putFacts: db.prepare('INSERT OR REPLACE INTO facts (content_hash, language, parser_version, data, stored_at) VALUES (?, ?, ?, ?, ?)'),
    getResolution: db.prepare('SELECT data FROM resolutions WHERE from_dir = ? AND specifier = ? AND config_hash = ?'),
    putResolution: db.prepare(
      `INSERT INTO resolutions (from_dir, specifier, config_hash, data) VALUES (?, ?, ?, ?)
       ON CONFLICT (from_dir, specifier, config_hash) DO UPDATE SET data = excluded.data RETURNING id`,
    ),
    deleteProbes: db.prepare('DELETE FROM resolution_probes WHERE resolution_id = ?'),
    putProbe: db.prepare('INSERT INTO resolution_probes (resolution_id, path) VALUES (?, ?)'),
    getSnapshot: db.prepare('SELECT data FROM snapshots WHERE commit_sha = ? AND config_hash = ?'),
    putSnapshot: db.prepare('INSERT OR REPLACE INTO snapshots (commit_sha, config_hash, data, created_at) VALUES (?, ?, ?, ?)'),
    stats: db.prepare(
      'SELECT (SELECT COUNT(*) FROM facts) AS facts, (SELECT COUNT(*) FROM resolutions) AS resolutions, (SELECT COUNT(*) FROM snapshots) AS snapshots',
    ),
  };
}

/** Creates the cache directory with a `.gitignore` of `*`, so the cache never shows up in the user's git status. */
function ensureCacheDir(dir: string): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.gitignore'), '# Created by depwave: local analysis cache, never commit it.\n*\n');
}

function removeDatabase(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
}

const isCorruption = (error: unknown): boolean =>
  error instanceof Error && ['SQLITE_CORRUPT', 'SQLITE_NOTADB'].includes(String((error as { code?: unknown }).code));
