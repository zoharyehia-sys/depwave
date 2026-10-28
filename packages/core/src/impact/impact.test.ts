import { describe, expect, it } from 'vitest';
import { analyzeChanges, changedSymbols } from '../diff/DiffAnalyzer.js';
import { DependencyGraph } from '../graph/DependencyGraph.js';
import { Confidence, type GraphEdge } from '../model/graph.js';
import { nodeId } from '../model/ids.js';
import type { LockfileDiff } from '../model/changes.js';
import type { Workspace } from '../model/workspace.js';
import { explainPath, predictImpact } from './ImpactPredictor.js';
import { allTests, selectTests } from './TestSelector.js';

const f = (path: string) => nodeId.file(path);

/** Tiny graph DSL: files "pkg/path" owned by pkg, edges "a -> b" meaning a imports b. */
function graph(files: string[], edges: Array<[string, string, Partial<GraphEdge>?]>, packages: Array<[string, string[]]> = []) {
  const g = new DependencyGraph();
  for (const [name] of packages) g.addNode({ id: nodeId.package(name), kind: 'package', name, root: name, manifestPath: `${name}/package.json` });
  for (const [name, deps] of packages) {
    for (const dep of deps) g.addEdge({ from: nodeId.package(name), to: nodeId.package(dep), kind: 'DEPENDS_ON', confidence: Confidence.certain, ownerFile: f(`${name}/package.json`) });
  }
  for (const path of files) {
    const pkg = path.split('/')[0]!;
    const packageId = packages.some(([n]) => n === pkg) ? nodeId.package(pkg) : undefined;
    g.addNode({ id: f(path), kind: 'file', path, contentHash: '', isTest: /\.test\.ts$/.test(path), hasSideEffects: false, ...(packageId ? { packageId } : {}) });
    if (packageId) g.addEdge({ from: packageId, to: f(path), kind: 'CONTAINS', confidence: Confidence.certain, ownerFile: f(path) });
  }
  for (const [from, to, extra] of edges) g.addEdge({ from: f(from), to: f(to), kind: 'IMPORTS', confidence: Confidence.certain, ownerFile: f(from), ...extra });
  return g;
}

const workspace = (names: string[], deps: Record<string, string[]> = {}): Workspace => ({
  tools: ['pnpm'],
  packages: names.map((name) => ({ name, root: name, manifestPath: `${name}/package.json`, dependencies: deps[name] ?? [] })),
});

describe('predictImpact', () => {
  it('walks dependents transitively, terminates on cycles, and records shortest paths', () => {
    const g = graph(['p/a.ts', 'p/b.ts', 'p/c.ts', 'p/d.ts', 'p/d.test.ts'], [
      ['p/a.ts', 'p/b.ts'],
      ['p/b.ts', 'p/c.ts'],
      ['p/c.ts', 'p/a.ts'], // cycle
      ['p/d.ts', 'p/a.ts'],
      ['p/d.test.ts', 'p/d.ts'],
    ]);
    const impacted = predictImpact(g, [f('p/c.ts')]);
    expect(impacted.map((n) => [n.id, n.distance])).toEqual([
      [f('p/c.ts'), 0],
      [f('p/b.ts'), 1],
      [f('p/a.ts'), 2],
      [f('p/d.ts'), 3],
      [f('p/d.test.ts'), 4],
    ]);
    expect(explainPath(impacted, f('p/d.test.ts'))).toEqual([f('p/d.test.ts'), f('p/d.ts'), f('p/a.ts'), f('p/b.ts'), f('p/c.ts')]);
  });

  it('keeps the weakest link on a path but upgrades when a more certain path exists', () => {
    const g = graph(['p/x.ts', 'p/glob.ts', 'p/direct.ts', 'p/top.ts'], [
      ['p/glob.ts', 'p/x.ts', { kind: 'DYNAMIC_IMPORT', confidence: Confidence.likely }],
      ['p/top.ts', 'p/glob.ts'],
      ['p/direct.ts', 'p/x.ts'],
      ['p/top.ts', 'p/direct.ts'],
    ]);
    const byId = new Map(predictImpact(g, [f('p/x.ts')]).map((n) => [n.id, n]));
    expect(byId.get(f('p/glob.ts'))?.confidence).toBe(Confidence.likely);
    expect(byId.get(f('p/top.ts'))?.confidence).toBe(Confidence.certain);
  });

  it('respects maxDepth and the type-only policy', () => {
    const g = graph(['p/a.ts', 'p/b.ts', 'p/c.ts'], [
      ['p/b.ts', 'p/a.ts', { typeOnly: true }],
      ['p/c.ts', 'p/b.ts'],
    ]);
    const base = { mode: 'conservative' as const, includeTypeOnly: true, followEdges: ['IMPORTS' as const] };
    expect(predictImpact(g, [f('p/a.ts')], base).length).toBe(3);
    expect(predictImpact(g, [f('p/a.ts')], { ...base, maxDepth: 1 }).length).toBe(2);
    expect(predictImpact(g, [f('p/a.ts')], { ...base, includeTypeOnly: false }).length).toBe(1);
  });

  it('reaches wildcard dependents from any file in their package, only in conservative mode', () => {
    const g = graph(['p/loader.ts', 'p/plugin.ts', 'q/other.ts'], [], [
      ['p', []],
      ['q', []],
    ]);
    g.addWildcardDependency('pkg:p', f('p/loader.ts'));
    const ids = (mode: 'conservative' | 'balanced', seed: string) =>
      predictImpact(g, [f(seed)], { mode, includeTypeOnly: true, followEdges: ['IMPORTS'] }).map((n) => n.id);
    expect(ids('conservative', 'p/plugin.ts')).toContain(f('p/loader.ts'));
    expect(ids('balanced', 'p/plugin.ts')).not.toContain(f('p/loader.ts'));
    expect(ids('conservative', 'q/other.ts')).not.toContain(f('p/loader.ts'));
    const loader = predictImpact(g, [f('p/plugin.ts')]).find((n) => n.id === f('p/loader.ts'));
    expect(loader?.confidence).toBe(Confidence.heuristic);
  });
});

describe('analyzeChanges', () => {
  const ws = workspace(['app', 'lib', 'util'], { app: ['lib'], lib: ['util'] });
  const g = graph(['app/a.ts', 'app/a.test.ts', 'lib/l.ts', 'util/u.ts', 'util/u.test.ts'], [], [
    ['app', ['lib']],
    ['lib', ['util']],
    ['util', []],
  ]);
  const ctx = { base: g, head: g, baseWorkspace: ws, headWorkspace: ws };
  const seeds = (...paths: string[]) => analyzeChanges(paths.map((path) => ({ status: 'M' as const, path })), ctx);

  it('seeds changed files, both sides of a rename, and ignores files no graph knows', () => {
    expect(analyzeChanges([{ status: 'R', path: 'lib/l.ts', oldPath: 'app/a.ts' }, { status: 'M', path: 'README.md' }], ctx)).toEqual({
      seeds: [f('app/a.ts'), f('lib/l.ts')],
      globalTriggers: [],
    });
  });

  it('a workspace manifest seeds its package and every transitive dependent package', () => {
    const result = seeds('util/package.json');
    expect(result.globalTriggers).toEqual([{ kind: 'package-manifest', path: 'util/package.json', scope: ['pkg:app', 'pkg:lib', 'pkg:util'] }]);
    expect(result.seeds).toEqual([f('app/a.test.ts'), f('app/a.ts'), f('lib/l.ts'), f('util/u.test.ts'), f('util/u.ts')]);
    expect(seeds('app/package.json').seeds).toEqual([f('app/a.test.ts'), f('app/a.ts')]); // nobody depends on app
  });

  it.each(['pnpm-lock.yaml', 'package.json', 'tsconfig.json', 'pnpm-workspace.yaml', 'vitest.config.ts'])('%s at the root affects everything', (path) => {
    const result = seeds(path);
    expect(result.seeds).toHaveLength(5);
    expect(result.globalTriggers[0]?.scope).toBeUndefined();
  });

  it('a nested tsconfig or test config affects only files under its directory', () => {
    expect(seeds('lib/tsconfig.json').seeds).toEqual([f('lib/l.ts')]);
    expect(seeds('util/vitest.config.ts').seeds).toEqual([f('util/u.test.ts'), f('util/u.ts')]);
  });

  it('a lockfile governs installs only at the root or a package root; elsewhere (test fixtures) it is data', () => {
    expect(seeds('lib/pnpm-lock.yaml').globalTriggers).toEqual([{ kind: 'lockfile', path: 'lib/pnpm-lock.yaml' }]);
    // Regression: this repo's own fixture lockfile (fixtures/<name>/repo/pnpm-lock.yaml) made every PR run everything.
    expect(seeds('fixtures/demo/repo/pnpm-lock.yaml').globalTriggers).toEqual([{ kind: 'data-file', path: 'fixtures/demo/repo/pnpm-lock.yaml', scope: ['pkg:<none>'] }]);
  });

  describe('an analyzed lockfile change', () => {
    const withLockfile = (diff: LockfileDiff) =>
      analyzeChanges([{ status: 'M', path: 'pnpm-lock.yaml' }], { ...ctx, lockfiles: new Map([['pnpm-lock.yaml', diff]]) });

    it('seeds the packages whose dependencies changed and their dependents, naming what changed', () => {
      const result = withLockfile({ kind: 'importers', importers: ['lib'], changes: ['ms 2.1.2 → 2.1.3', '+ chalk 5.3.0', '- request 2.88.2', 'debug 4.3.4 → 4.3.5'] });
      expect(result.globalTriggers).toEqual([
        { kind: 'lockfile', path: 'pnpm-lock.yaml', scope: ['pkg:app', 'pkg:lib'], detail: 'ms 2.1.2 → 2.1.3, + chalk 5.3.0, - request 2.88.2 and 1 more' },
      ]);
      expect(result.seeds).toEqual([f('app/a.test.ts'), f('app/a.ts'), f('lib/l.ts')]); // util untouched
    });

    it('seeds nothing when no importer is affected', () => {
      expect(withLockfile({ kind: 'importers', importers: [], changes: [] })).toEqual({
        seeds: [],
        globalTriggers: [{ kind: 'lockfile', path: 'pnpm-lock.yaml', scope: [], detail: 'resolution metadata only' }],
      });
    });

    it.each([
      ['the root importer changed', { kind: 'importers', importers: ['', 'lib'], changes: ['typescript 5.4.5 → 5.4.6'] }, /^the repo root's dependencies changed \(typescript 5\.4\.5 → 5\.4\.6\)/],
      ['an importer is not a workspace package', { kind: 'importers', importers: ['tools/gen'], changes: [] }, /^dependencies of tools\/gen changed .* not a workspace package/],
      ['the adapter gave up', { kind: 'all', reason: 'pnpm lockfileVersion 5.4 is not analyzed' }, /^pnpm lockfileVersion 5\.4/],
    ] as const)('selects everything, saying why, when %s', (_, diff, detail) => {
      const result = withLockfile(diff as LockfileDiff);
      expect(result.globalTriggers).toEqual([{ kind: 'lockfile', path: 'pnpm-lock.yaml', detail: expect.stringMatching(detail) }]);
      expect(result.seeds).toHaveLength(5);
    });
  });
});

describe('selectTests', () => {
  it('groups head-revision tests by package, orders by score, and picks the runner', () => {
    const g = graph(['app/a.test.ts', 'app/b.test.ts', 'lib/l.test.ts'], [], [
      ['app', []],
      ['lib', []],
    ]);
    const ws: Workspace = {
      tools: [],
      packages: [
        { name: 'app', root: 'app', manifestPath: 'app/package.json', dependencies: ['jest'] },
        { name: 'lib', root: 'lib', manifestPath: 'lib/package.json', dependencies: [] },
        { name: 'root', root: '', manifestPath: 'package.json', dependencies: ['vitest'] },
      ],
    };
    const impacted = [
      { id: f('app/a.test.ts'), distance: 3, confidence: Confidence.certain, score: 0.6 },
      { id: f('app/b.test.ts'), distance: 1, confidence: Confidence.certain, score: 0.85 },
      { id: f('lib/l.test.ts'), distance: 1, confidence: Confidence.certain, score: 0.85 },
      { id: f('app/deleted.test.ts'), distance: 1, confidence: Confidence.certain, score: 0.85 }, // not in head
    ];
    const plan = selectTests(impacted, g, { seeds: [], globalTriggers: [] }, ws);
    expect(plan).toEqual({
      runAll: false,
      groups: [
        { packageName: 'app', runner: 'jest', tests: ['app/b.test.ts', 'app/a.test.ts'] },
        { packageName: 'lib', runner: 'vitest', tests: ['lib/l.test.ts'] }, // falls back to the root's runner
      ],
    });
    expect(allTests(plan)).toEqual(['app/a.test.ts', 'app/b.test.ts', 'lib/l.test.ts']);
  });

  it('flags runAll when a repo-wide trigger fired', () => {
    const plan = selectTests([], new DependencyGraph(), { seeds: [], globalTriggers: [{ kind: 'lockfile', path: 'pnpm-lock.yaml' }] }, workspace([]));
    expect(plan.runAll).toBe(true);
  });
});

describe('analyzeChanges: changes no import expresses (regressions from tRPC and Vite)', () => {
  const ws = workspace(['app', 'lib']);
  const g = graph(['app/a.ts', 'app/a.test.ts', 'app/__tests__/cli.test.ts', 'lib/l.ts', 'lib/l.test.ts'], [], [
    ['app', []],
    ['lib', []],
  ]);
  const ctx = { base: g, head: g, baseWorkspace: ws, headWorkspace: ws };
  const run = (...paths: string[]) => analyzeChanges(paths.map((path) => ({ status: 'M' as const, path })), ctx);

  it.each(['.github/workflows/main.yml', '.github/actions/setup/action.yml', '.gitlab-ci.yml', '.nvmrc', '.node-version', '.tool-versions', '.bun-version', '.npmrc'])(
    'tRPC: %s (CI / toolchain) affects every test',
    (path) => {
      const result = run(path);
      expect(result.globalTriggers).toEqual([{ kind: 'ci-config', path }]);
      expect(result.seeds).toHaveLength(5);
    },
  );

  it('a toolchain pin only counts at the repository root', () => {
    expect(run('app/.nvmrc').globalTriggers[0]?.kind).toBe('data-file');
  });

  it('Vite: a data file no code imports selects the tests of its package only', () => {
    expect(run('app/templates/vanilla/package.json')).toEqual({
      seeds: [nodeId.file('app/__tests__/cli.test.ts'), nodeId.file('app/a.test.ts')],
      globalTriggers: [{ kind: 'data-file', path: 'app/templates/vanilla/package.json', scope: ['pkg:app'] }],
    });
  });

  it("depwave itself: a data file reaches other packages' tests through the test helper that loads it", () => {
    // tools/test/support/load.ts reads tools/test/fixtures/*.json at runtime; lib's test imports the helper.
    const files = ['tools/test/support/load.ts', 'tools/test/golden.test.ts', 'tools/src/cli.ts', 'lib/l.ts', 'lib/l.test.ts', 'lib/other.test.ts'];
    const helperGraph = graph(files, [['lib/l.test.ts', 'tools/test/support/load.ts']], [['lib', []], ['tools', []]]);
    const helperWs = workspace(['lib', 'tools']);
    const changeSet = analyzeChanges([{ status: 'M', path: 'tools/test/fixtures/demo.json' }], { base: helperGraph, head: helperGraph, baseWorkspace: helperWs, headWorkspace: helperWs });
    expect(changeSet.seeds).toEqual([nodeId.file('tools/test/golden.test.ts'), nodeId.file('tools/test/support/load.ts')]); // not tools/src/cli.ts
    const tests = predictImpact(helperGraph, changeSet.seeds).map((n) => n.id).filter((id) => id.endsWith('.test.ts')).sort();
    expect(tests).toEqual([nodeId.file('lib/l.test.ts'), nodeId.file('tools/test/golden.test.ts')]); // not lib/other.test.ts
  });

  it('a snapshot maps to exactly its own test', () => {
    expect(run('lib/__snapshots__/l.test.ts.snap')).toEqual({ seeds: [nodeId.file('lib/l.test.ts')], globalTriggers: [] });
  });

  it.each(['app/README.md', 'docs/guide.md', 'CHANGELOG.md', 'LICENSE', '.gitignore', '.vscode/settings.json', '.github/ISSUE_TEMPLATE/bug.yml', 'renovate.json'])(
    '%s selects nothing',
    (path) => {
      expect(run(path)).toEqual({ seeds: [], globalTriggers: [] });
    },
  );

  it('…unless it sits in a test data directory (a Markdown processor reads fixtures/*.md)', () => {
    expect(run('lib/fixtures/input.md').globalTriggers).toEqual([{ kind: 'data-file', path: 'lib/fixtures/input.md', scope: ['pkg:lib'] }]);
  });

  it('a file whose extraction crashed always counts as wholly changed', () => {
    const facts = (failed?: string) => ({
      path: 'app/a.ts',
      language: 'typescript' as const,
      contentHash: failed ?? 'h',
      parserVersion: 't',
      imports: [],
      exports: [],
      symbols: [],
      references: [],
      hasSideEffects: false,
      moduleHash: '',
      parseErrors: 0,
      ...(failed ? { failed } : {}),
    });
    expect(changedSymbols('app/a.ts', facts(), facts())).toEqual([]);
    expect(changedSymbols('app/a.ts', facts('RangeError: Maximum call stack size exceeded'), facts())).toBeUndefined();
  });
});
