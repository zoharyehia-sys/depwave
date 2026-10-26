import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type FixtureChange =
  | { op: 'modify'; path: string; find: string; replace: string }
  | { op: 'add'; path: string; content: string }
  | { op: 'delete'; path: string }
  | { op: 'rename'; path: string; to: string };

export interface Expectation {
  impactedTests: string[];
}

export interface Scenario {
  name: string;
  description?: string;
  changes: FixtureChange[];
  expected: { file: Expectation; symbol?: Expectation };
}

export interface FixtureSpec {
  description: string;
  policy: 'conservative' | 'balanced' | 'aggressive';
  cycles?: string[][];
  scenarios: Scenario[];
}

export interface Fixture {
  name: string;
  /** Absolute path of the fixture's repo/ directory. */
  repoDir: string;
  spec: FixtureSpec;
  /** Repo-relative POSIX path → content, before any scenario is applied. */
  files: ReadonlyMap<string, string>;
}

export const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures/', import.meta.url));

export const isTestFile = (path: string): boolean => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);

/** Symbol-level expectations default to file-level ones. */
export const symbolExpectation = (scenario: Scenario): Expectation => scenario.expected.symbol ?? scenario.expected.file;

export async function loadFixtures(): Promise<Fixture[]> {
  const entries = await readdir(FIXTURES_DIR, { withFileTypes: true });
  const names = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();

  return Promise.all(
    names.map(async (name) => {
      const repoDir = join(FIXTURES_DIR, name, 'repo');
      const spec = JSON.parse(await readFile(join(FIXTURES_DIR, name, 'expected-impact.json'), 'utf8')) as FixtureSpec;
      return { name, repoDir, spec, files: await readTree(repoDir) };
    }),
  );
}

async function readTree(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const abs = join(entry.parentPath, entry.name);
    files.set(relative(root, abs).split(sep).join('/'), await readFile(abs, 'utf8'));
  }
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

/** Applies a scenario's changes to an in-memory tree. Throws on anything ambiguous so goldens stay honest. */
export function applyChanges(files: ReadonlyMap<string, string>, changes: readonly FixtureChange[]): Map<string, string> {
  const next = new Map(files);
  for (const change of changes) {
    const current = next.get(change.path);
    switch (change.op) {
      case 'modify': {
        if (current === undefined) throw new Error(`modify: ${change.path} does not exist`);
        const count = current.split(change.find).length - 1;
        if (count !== 1) throw new Error(`modify: "${change.find}" occurs ${count} times in ${change.path}, expected exactly 1`);
        const updated = current.replace(change.find, () => change.replace);
        if (updated === current) throw new Error(`modify: replacement is a no-op in ${change.path}`);
        next.set(change.path, updated);
        break;
      }
      case 'add':
        if (current !== undefined) throw new Error(`add: ${change.path} already exists`);
        next.set(change.path, change.content);
        break;
      case 'delete':
        if (current === undefined) throw new Error(`delete: ${change.path} does not exist`);
        next.delete(change.path);
        break;
      case 'rename':
        if (current === undefined) throw new Error(`rename: ${change.path} does not exist`);
        if (next.has(change.to)) throw new Error(`rename: ${change.to} already exists`);
        next.delete(change.path);
        next.set(change.to, current);
        break;
      default:
        throw new Error(`Unknown change op: ${JSON.stringify(change satisfies never)}`);
    }
  }
  return next;
}
