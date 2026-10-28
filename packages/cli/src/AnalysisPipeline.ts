import { join } from 'node:path';
import { CacheManager } from '@depwave/cache';
import {
  analyzeChanges,
  buildGraph,
  DependencyGraph,
  GRAPH_VERSION,
  predictImpact,
  selectTests,
  SNAPSHOT_FORMAT,
  nodeId,
  UnionGraph,
  WORKTREE,
  type CachePort,
  type FileChange,
  type FileFacts,
  type GitPort,
  type GraphView,
  type Granularity,
  type ImpactReport,
  type Inventory,
  type InventoryPort,
  type LockfileDiff,
  type LockfilePort,
  type ParserPort,
  type ResolverPort,
  type Revision,
  type SourceFile,
  type TestPlan,
  type UnresolvedImport,
  type Workspace,
} from '@depwave/core';
import { GitService } from '@depwave/git';
import { ASTParser } from '@depwave/parser';
import { ModuleResolver, RESOLVER_VERSION } from '@depwave/resolver';
import { LockfileAnalyzer, SourceInventory, WorkspaceDiscovery } from '@depwave/workspace';
import { VERSION } from './version.js';

export interface PipelineDeps {
  git: GitPort;
  inventory: InventoryPort;
  parser: ParserPort;
  /** Resolution depends on the revision's files and workspace, so a resolver is built per revision. */
  createResolver(rev: Revision, inventory: Inventory): Promise<ResolverPort>;
  /** Optional persistent cache. Failures disable it for the run; they never fail the analysis. */
  cache?: CachePort;
  /** Everything that can change analysis output for identical input. Part of every snapshot key. */
  analysisVersion: string;
  /** Default 'symbol'. 'file' reproduces the Phase 1 file-level analysis. */
  granularity?: Granularity;
  /** Narrows lockfile changes to the packages whose dependencies changed. Without it, a lockfile change selects everything. */
  lockfiles?: LockfilePort;
}

export interface ImpactRequest {
  base: Revision;
  head: Revision;
}

export interface RunStats {
  /** Revisions served whole from the L3 snapshot cache. */
  snapshotHits: number;
  /** Source files whose facts came from the L1 cache. */
  factsFromCache: number;
  /** Source files actually parsed with Tree-sitter. */
  filesParsed: number;
  /** Set when the cache failed and the run continued without it. */
  cacheWarning?: string;
}

export interface ImpactResult {
  report: ImpactReport;
  plan: TestPlan;
  stats: RunStats;
  /** Base ∪ head graph the impact walk ran on: what `depwave why` reads edges from. */
  graph: GraphView;
}

interface Snapshot {
  workspace: Workspace;
  graph: DependencyGraph;
  unresolved: UnresolvedImport[];
}

/**
 * Orchestrates one analysis run (ARCHITECTURE.md §3.5). Takes ports, so tests can inject fakes.
 *
 *   merge-base → diff → graph(base) + graph(head) → seeds (DiffAnalyzer) → reverse BFS over base ∪ head → tests
 *
 * Graphs come from git (no checkout). Commits hit the L3 snapshot cache; everything else hits L1 facts per file.
 */
export class AnalysisPipeline {
  private readonly factsByHash = new Map<string, FileFacts>();
  private stats: RunStats = { snapshotHits: 0, factsFromCache: 0, filesParsed: 0 };
  private cache: CachePort | undefined;
  private readonly granularity: Granularity;
  private readonly snapshotKey: string;

  constructor(readonly deps: PipelineDeps) {
    this.cache = deps.cache;
    this.granularity = deps.granularity ?? 'symbol';
    this.snapshotKey = `${deps.analysisVersion}|granularity@${this.granularity}`;
  }

  async impact({ base, head }: ImpactRequest): Promise<ImpactResult> {
    this.stats = { snapshotHits: 0, factsFromCache: 0, filesParsed: 0 };
    const { git } = this.deps;
    const mergeBase = await git.mergeBase(base, head);
    const headRev = await git.resolveRevision(head);
    const changes = await git.diff(mergeBase, headRev);

    const before = await this.snapshot(mergeBase);
    const after = await this.snapshot(headRev);

    const modified = changes.filter((c) => c.status === 'M').map((c) => c.path);
    const symbolLevel = this.granularity === 'symbol';
    const changeSet = analyzeChanges(changes, {
      base: before.graph,
      head: after.graph,
      baseWorkspace: before.workspace,
      headWorkspace: after.workspace,
      granularity: this.granularity,
      lockfiles: await this.lockfileDiffs(changes, mergeBase, headRev),
      ...(symbolLevel
        ? { baseFacts: await this.factsAt(mergeBase, before.graph, modified), headFacts: await this.factsAt(headRev, after.graph, modified) }
        : {}),
    });
    const graph = new UnionGraph([after.graph, before.graph]);
    const impacted = predictImpact(graph, changeSet.seeds);
    const plan = selectTests(impacted, after.graph, changeSet, after.workspace);
    plan.totalTests = [...after.graph.nodes('file')].filter((f) => f.isTest).length;

    return {
      report: {
        base: mergeBase,
        head: headRev,
        granularity: this.granularity,
        changedFiles: [...new Set(changes.flatMap((c) => (c.oldPath === undefined ? [c.path] : [c.oldPath, c.path])))].sort(),
        seeds: changeSet.seeds,
        globalTriggers: changeSet.globalTriggers,
        impacted: impacted.sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1)),
        unresolved: after.unresolved,
        ...(after.workspace.warnings?.length ? { warnings: after.workspace.warnings } : {}),
      },
      plan,
      stats: this.stats,
      graph,
    };
  }

  /** Both sides of every changed lockfile the adapter understands, plus the config that decides hoisting, at head. */
  private async lockfileDiffs(changes: readonly FileChange[], base: Revision, head: Revision): Promise<Map<string, LockfileDiff>> {
    const port = this.deps.lockfiles;
    const diffs = new Map<string, LockfileDiff>();
    const targets = port ? changes.filter((c) => c.oldPath === undefined && port.supports(c.path)) : [];
    if (!port || targets.length === 0) return diffs;

    const config = [...new Set(targets.flatMap((c) => port.layoutConfigPaths(c.path)))];
    const before = await this.deps.git.readBlobs(base, targets.filter((c) => c.status !== 'A').map((c) => c.path));
    const after = await this.deps.git.readBlobs(head, [...targets.filter((c) => c.status !== 'D').map((c) => c.path), ...config]);
    for (const { path } of targets) {
      const layoutConfig = new Map(port.layoutConfigPaths(path).flatMap((p) => (after.has(p) ? [[p, after.get(p)!] as const] : [])));
      diffs.set(path, port.diff({ path, before: before.get(path), after: after.get(path), layoutConfig }));
    }
    return diffs;
  }

  private async snapshot(rev: Revision): Promise<Snapshot> {
    const cacheable = rev !== WORKTREE; // a working tree has no immutable identity
    if (cacheable) {
      const hit = this.cached((c) => c.loadSnapshot(rev, this.snapshotKey));
      if (hit?.formatVersion === SNAPSHOT_FORMAT) {
        this.stats.snapshotHits++;
        return { workspace: hit.workspace, graph: DependencyGraph.fromData(hit), unresolved: hit.unresolved };
      }
    }

    const inventory = await this.deps.inventory.inventory(rev);
    const facts = await this.parse(rev, inventory.files);
    const resolver = await this.deps.createResolver(rev, inventory);
    const { graph, unresolved } = buildGraph({ inventory, facts, resolver, granularity: this.granularity });

    if (cacheable) {
      this.cached((c) =>
        c.saveSnapshot({
          formatVersion: SNAPSHOT_FORMAT,
          commit: rev,
          configHash: this.snapshotKey,
          workspace: inventory.workspace,
          ...graph.toData(),
          unresolved,
        }),
      );
    }
    return { workspace: inventory.workspace, graph, unresolved };
  }

  private async parse(rev: Revision, files: readonly SourceFile[]): Promise<Map<string, FileFacts>> {
    const parserVersion = this.deps.parser.version;
    let missing = files.filter((f) => !this.factsByHash.has(f.contentHash));

    // L1: facts are a pure function of content, so any cached copy is valid.
    missing = missing.filter((f) => {
      const cached = this.cached((c) => c.getFacts({ contentHash: f.contentHash, language: f.language, parserVersion }));
      if (!cached) return true;
      this.factsByHash.set(f.contentHash, cached);
      this.stats.factsFromCache++;
      return false;
    });

    if (missing.length > 0) {
      const contents = await this.deps.git.readBlobs(rev, missing.map((f) => f.path));
      const inputs = missing.filter((f) => contents.has(f.path)).map((f) => ({ ...f, content: contents.get(f.path)! }));
      const fresh: FileFacts[] = [];
      for await (const facts of this.deps.parser.extract(inputs)) {
        this.factsByHash.set(facts.contentHash, facts);
        fresh.push(facts);
      }
      this.stats.filesParsed += fresh.length;
      this.cached((c) => c.putFacts(fresh)); // one transaction for the whole batch
    }

    // Identical content at another path (copies, renames) shares facts; re-stamp the path.
    return new Map(
      files.flatMap((f) => {
        const facts = this.factsByHash.get(f.contentHash);
        return facts ? [[f.path, { ...facts, path: f.path }] as const] : [];
      }),
    );
  }

  /** Facts for specific source files of a revision (memo → L1 → parse), e.g. the files a diff modified. */
  private async factsAt(rev: Revision, graph: DependencyGraph, paths: readonly string[]): Promise<Map<string, FileFacts>> {
    const files = paths.flatMap((path): SourceFile[] => {
      const node = graph.node(nodeId.file(path));
      return node?.kind === 'file' && node.language !== undefined && node.contentHash !== '' ? [{ path, language: node.language, contentHash: node.contentHash }] : [];
    });
    return this.parse(rev, files);
  }

  /** Runs a cache operation; on any failure, disables the cache for the rest of the run and records why. */
  private cached<T>(operation: (cache: CachePort) => T): T | undefined {
    if (!this.cache) return undefined;
    try {
      return operation(this.cache);
    } catch (error) {
      this.stats.cacheWarning = `cache disabled for this run: ${error instanceof Error ? error.message : String(error)}`;
      this.cache = undefined;
      return undefined;
    }
  }
}

export const ANALYSIS_VERSION = `depwave@${VERSION}|graph@${GRAPH_VERSION}|resolver@${RESOLVER_VERSION}`;

export interface PipelineOptions {
  /** Use the persistent cache at `<repo root>/.depwave/cache.db`. Default true. */
  cache?: boolean;
  /** Default 'symbol'. */
  granularity?: Granularity;
}

/** Composition root: the only place adapters are instantiated. */
export async function createPipeline(cwd: string, options: PipelineOptions = {}): Promise<AnalysisPipeline> {
  const git = new GitService(cwd);
  const parser = new ASTParser();
  return new AnalysisPipeline({
    git,
    // Only files the parser can read are source. Anything else (a .py helper in a JS repo) is data: a change to it
    // selects its package's tests instead of crashing the run (Playwright: "No language adapter for …py").
    inventory: new SourceInventory(git, new WorkspaceDiscovery(git), (path) => parser.supports(path)),
    parser,
    createResolver: (rev, inventory) => ModuleResolver.load(git, rev, inventory.workspace, inventory.paths),
    lockfiles: new LockfileAnalyzer(),
    ...(options.cache === false ? {} : { cache: new CacheManager(cachePath(await git.root())) }),
    analysisVersion: `${ANALYSIS_VERSION}|parser@${parser.version}`,
    ...(options.granularity ? { granularity: options.granularity } : {}),
  });
}

export const cachePath = (repoRoot: string): string => join(repoRoot, '.depwave', 'cache.db');
