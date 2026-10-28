import { NO_PACKAGE, type DependencyGraph } from '../graph/DependencyGraph.js';
import type { ChangeSet, FileChange, GlobalTrigger, LockfileDiff } from '../model/changes.js';
import type { FileFacts, SymbolFact } from '../model/facts.js';
import { MODULE_SYMBOL, type Granularity } from '../model/graph.js';
import { nodeId, type NodeId } from '../model/ids.js';
import type { Workspace } from '../model/workspace.js';
import { baseNameOf, dirOf, isWithin } from '../paths.js';

export interface DiffContext {
  base: DependencyGraph;
  head: DependencyGraph;
  baseWorkspace: Workspace;
  headWorkspace: Workspace;
  /** Default 'file'. 'symbol' seeds only symbols whose content actually changed. */
  granularity?: Granularity;
  /** Facts of changed source files at base / head (symbol granularity). Missing → the whole file counts as changed. */
  baseFacts?: ReadonlyMap<string, FileFacts>;
  headFacts?: ReadonlyMap<string, FileFacts>;
  /** Analyzed lockfile changes by path. A changed lockfile without an entry selects everything. */
  lockfiles?: ReadonlyMap<string, LockfileDiff>;
}

const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb']);
const WORKSPACE_CONFIGS = new Set(['pnpm-workspace.yaml', 'nx.json', 'turbo.json', 'lerna.json', 'depwave.config.json']);
/** CI definitions and toolchain pins: they change the environment every test runs in (a Node or Bun bump breaks tests). */
const CI_PATH = /^(\.github\/(workflows|actions)\/|\.circleci\/|\.buildkite\/|\.gitlab-ci\.yml$|azure-pipelines\.ya?ml$|Jenkinsfile$|bitbucket-pipelines\.yml$)/;
const TOOLCHAIN_PINS = new Set(['.nvmrc', '.node-version', '.tool-versions', '.bun-version', '.npmrc', '.yarnrc.yml', '.pnpmfile.cjs', 'rust-toolchain', 'rust-toolchain.toml']);
/** Changed files that can't affect a test run, unless they sit in a test data directory. */
const NOT_DATA = /(\.(md|mdx|markdown|rst|adoc)$|^(license|licence|notice|changelog|authors|codeowners|contributing|security)(\.[a-z]+)?$|^\.(gitignore|gitattributes|editorconfig|prettierignore|eslintignore|mailmap)$|^\.prettierrc|^\.markdownlint|^renovate\.json5?$)/i;
const NOT_DATA_DIR = /^(\.vscode|\.idea|\.changeset|\.husky|docs?)(\/|$)|^\.github\//;
const TEST_DATA_DIR = /(^|\/)(__fixtures__|fixtures?|__tests__|tests?|testdata|__snapshots__|__mocks__)\//;

/** Config files that change how everything under their directory compiles or runs. */
const DIRECTORY_CONFIG = /^(tsconfig.*\.json|jsconfig.*\.json|(vitest|vite|jest)\.(config|workspace)\.[cm]?[jt]s|babel\.config\.[cm]?js|\.babelrc(\.json)?)$/;

/**
 * File-level change analysis: every changed path (both sides of a rename) is a seed, plus global triggers for files
 * whose effect isn't visible as an import edge:
 *
 *   workspace config, root package.json             → everything
 *   lockfile                                        → the packages whose resolved dependencies changed, and their
 *                                                     dependents (everything if the adapter can't tell)
 *   tsconfig / test-runner / babel config in dir D  → every file under D
 *   a workspace package's manifest                  → that package and every package that (transitively) depends on it
 *
 * Seeds come from BOTH graphs, so a deleted file seeds its old dependents and an added one its new dependents.
 *
 * Symbol granularity narrows a modified source file to what really changed, by comparing facts structurally:
 *   - a symbol whose bodyHash or export status differs (or that exists on one side only) is a seed;
 *   - a different moduleHash (imports, top-level code) seeds `<module>`, which every symbol of the file depends on;
 *   - equal hashes everywhere (comment/whitespace-only edits, moved code) seed nothing.
 * Comparing hashes rather than mapping diff hunks to line spans is both simpler and more exact: moving an unchanged
 * function produces hunks, but no hash changes.
 */
export function analyzeChanges(changes: readonly FileChange[], ctx: DiffContext): ChangeSet {
  const seeds = new Set<NodeId>();
  const triggers: GlobalTrigger[] = [];
  const allFiles = [...new Set([...ctx.head.nodes('file'), ...ctx.base.nodes('file')].map((f) => f.path))];
  const symbolLevel = ctx.granularity === 'symbol';

  /** The whole file: its node, plus (symbol granularity) its top-level code, which reaches every symbol in it. */
  const seedWholeFile = (path: string) => {
    for (const id of [nodeId.file(path), ...(symbolLevel ? [nodeId.symbol(path, MODULE_SYMBOL)] : [])]) {
      if (ctx.head.node(id) || ctx.base.node(id)) seeds.add(id);
    }
  };
  const seedFilesWhere = (predicate: (path: string) => boolean) => {
    for (const path of allFiles) if (predicate(path)) seedWholeFile(path);
  };

  for (const change of changes) {
    const changed = symbolLevel && change.status === 'M' ? changedSymbols(change.path, ctx.baseFacts?.get(change.path), ctx.headFacts?.get(change.path)) : undefined;
    if (changed) {
      for (const id of changed) seeds.add(id);
    }

    for (const path of change.oldPath === undefined ? [change.path] : [change.path, change.oldPath]) {
      if (!changed) seedWholeFile(path);

      const trigger = classify(path, ctx) ?? dataFileTrigger(path, ctx, (test) => seeds.add(nodeId.file(test)));
      if (!trigger) continue;
      triggers.push(trigger);
      if (trigger.scope === undefined) {
        seedFilesWhere(() => true);
      } else if (trigger.kind === 'data-file') {
        const scope = new Set(trigger.scope);
        for (const graph of [ctx.head, ctx.base]) {
          for (const pkg of scope) {
            for (const file of graph.filesOf(pkg)) {
              if (file.isTest) seeds.add(file.id);
              // A test helper that loads the data (test/support/fixtures.ts) carries it to every test importing the
              // helper, in any package. Regression: fixture edits here missed packages/parser's fixture-driven tests.
              else if (TEST_DATA_DIR.test(file.path)) seedWholeFile(file.path);
            }
          }
        }
      } else if (trigger.kind === 'package-manifest' || trigger.kind === 'lockfile') {
        const scope = new Set(trigger.scope);
        for (const graph of [ctx.head, ctx.base]) {
          for (const pkg of scope) for (const file of graph.filesOf(pkg)) seedWholeFile(file.path);
        }
      } else {
        seedFilesWhere((p) => isWithin(p, dirOf(path)));
      }
    }
  }

  return { seeds: [...seeds].sort(), globalTriggers: triggers };
}

/**
 * Symbols that differ between two versions of one file, or undefined when the file must count as wholly changed
 * (facts missing on a side, or top-level code changed).
 */
export function changedSymbols(path: string, before: FileFacts | undefined, after: FileFacts | undefined): NodeId[] | undefined {
  // Missing or crashed facts, or changed top-level code: the whole file counts as changed.
  if (!before || !after || before.failed !== undefined || after.failed !== undefined || before.moduleHash !== after.moduleHash) return undefined;
  const old = new Map(before.symbols.map((s) => [s.name, s]));
  const now = new Map(after.symbols.map((s) => [s.name, s]));
  const differs = (a: SymbolFact | undefined, b: SymbolFact | undefined) => !a || !b || a.bodyHash !== b.bodyHash || a.exported !== b.exported;

  const changed = new Set<string>();
  for (const name of [...old.keys(), ...now.keys()]) if (differs(old.get(name), now.get(name))) changed.add(name);
  return [...changed].sort().map((name) => nodeId.symbol(path, name));
}

function classify(path: string, ctx: DiffContext): GlobalTrigger | undefined {
  const name = baseNameOf(path);
  const dir = dirOf(path);

  // Only a lockfile that governs an install counts: at the root or a package root. One in test fixtures is data.
  if (LOCKFILES.has(name) && (dir === '' || [...ctx.headWorkspace.packages, ...ctx.baseWorkspace.packages].some((p) => p.root === dir))) {
    return lockfileTrigger(path, ctx);
  }
  if (CI_PATH.test(path) || (dir === '' && TOOLCHAIN_PINS.has(name))) return { kind: 'ci-config', path };
  if (dir === '' && WORKSPACE_CONFIGS.has(name)) return { kind: 'custom', path };
  if (path === 'package.json') return { kind: 'package-manifest', path };

  if (name === 'package.json') {
    const pkg = [...ctx.headWorkspace.packages, ...ctx.baseWorkspace.packages].find((p) => p.manifestPath === path);
    if (pkg) return { kind: 'package-manifest', path, scope: withDependents(nodeId.package(pkg.name), ctx) };
  }
  if (DIRECTORY_CONFIG.test(name)) {
    if (dir === '') return { kind: 'tsconfig', path };
    const packages = [...ctx.headWorkspace.packages].filter((p) => isWithin(p.root, dir) || isWithin(dir, p.root)).map((p) => nodeId.package(p.name));
    return { kind: name.startsWith('tsconfig') || name.startsWith('jsconfig') ? 'tsconfig' : 'custom', path, scope: packages.length > 0 ? packages : [NO_PACKAGE] };
  }
  return undefined;
}

/**
 * A lockfile change scoped to the workspace packages whose resolved dependencies changed, plus their dependents.
 * Anything that can't be pinned to a package (the root importer, whose node_modules every package can load from; an
 * importer that isn't a workspace package; an unanalyzed lockfile) selects everything, saying why.
 */
function lockfileTrigger(path: string, ctx: DiffContext): GlobalTrigger {
  const diff = ctx.lockfiles?.get(path);
  if (!diff) return { kind: 'lockfile', path };
  if (diff.kind === 'all') return { kind: 'lockfile', path, detail: diff.reason };

  const changed = summarize(diff.changes);
  const packages = [...ctx.headWorkspace.packages, ...ctx.baseWorkspace.packages];
  const scope = new Set<NodeId>();
  for (const dir of diff.importers) {
    if (dir === '') return { kind: 'lockfile', path, detail: `the repo root's dependencies changed (${changed}); every package can load them` };
    const pkg = packages.find((p) => p.root === dir);
    if (!pkg) return { kind: 'lockfile', path, detail: `dependencies of ${dir} changed (${changed}), and it is not a workspace package` };
    for (const id of withDependents(nodeId.package(pkg.name), ctx)) scope.add(id);
  }
  // Hoisted node_modules: code may import what its manifest never declared. Its package is affected all the same.
  if (diff.hoisted?.length) {
    const loaded = new Set(diff.hoisted);
    for (const graph of [ctx.head, ctx.base]) {
      for (const file of graph.nodes('file')) {
        if (file.externals?.some((name) => loaded.has(name))) for (const id of withDependents(file.packageId ?? NO_PACKAGE, ctx)) scope.add(id);
      }
    }
  }
  return { kind: 'lockfile', path, scope: [...scope].sort(), detail: changed };
}

const summarize = (changes: readonly string[]): string => {
  if (changes.length === 0) return 'resolution metadata only';
  return changes.length <= 3 ? changes.join(', ') : `${changes.slice(0, 3).join(', ')} and ${changes.length - 3} more`;
};

/**
 * A changed file no import reaches (JSON/text fixtures, templates, snapshots, images) may still be read by tests at
 * runtime, which no static graph can see. A Jest/Vitest snapshot maps to its own test exactly; any other such file
 * selects the tests of its package, and every test that imports one of its test helpers (non-test code in test dirs). Documentation and editor/lint config outside test-data directories select nothing.
 */
function dataFileTrigger(path: string, ctx: DiffContext, seedTest: (testPath: string) => void): GlobalTrigger | undefined {
  const id = nodeId.file(path);
  if (ctx.head.node(id) || ctx.base.node(id)) return undefined; // source or imported: the graph already covers it

  const snapshot = /^(.*)\/__snapshots__\/([^/]+)\.snap$/.exec(path);
  if (snapshot) {
    const test = `${snapshot[1]}/${snapshot[2]}`;
    if (ctx.head.node(nodeId.file(test)) || ctx.base.node(nodeId.file(test))) {
      seedTest(test);
      return undefined;
    }
  }

  const name = baseNameOf(path);
  if (!TEST_DATA_DIR.test(path) && (NOT_DATA.test(name) || NOT_DATA_DIR.test(path))) return undefined;
  const owner = [...ctx.headWorkspace.packages, ...ctx.baseWorkspace.packages]
    .filter((p) => isWithin(path, p.root))
    .sort((a, b) => b.root.length - a.root.length)[0];
  return { kind: 'data-file', path, scope: [owner ? nodeId.package(owner.name) : NO_PACKAGE] };
}

/** `pkg` plus every package that depends on it, directly or transitively, in either graph. */
function withDependents(pkg: NodeId, ctx: DiffContext): NodeId[] {
  const found = new Set<NodeId>([pkg]);
  const queue = [pkg];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const graph of [ctx.head, ctx.base]) {
      for (const edge of graph.inEdges(current)) {
        if (edge.kind === 'DEPENDS_ON' && !found.has(edge.from)) {
          found.add(edge.from);
          queue.push(edge.from);
        }
      }
    }
  }
  return [...found].sort();
}
