import {
  analyzeChanges,
  buildGraph,
  predictImpact,
  selectTests,
  UnionGraph,
  type DependencyGraph,
  type FileFacts,
  type GitPort,
  type ImpactReport,
  type Inventory,
  type InventoryPort,
  type ParserPort,
  type ResolverPort,
  type Revision,
  type SourceFile,
  type TestPlan,
  type UnresolvedImport,
} from '@depwave/core';
import { GitService } from '@depwave/git';
import { ASTParser } from '@depwave/parser';
import { ModuleResolver } from '@depwave/resolver';
import { SourceInventory, WorkspaceDiscovery } from '@depwave/workspace';

export interface PipelineDeps {
  git: GitPort;
  inventory: InventoryPort;
  parser: ParserPort;
  /** Resolution depends on the revision's files and workspace, so a resolver is built per revision. */
  createResolver(rev: Revision, inventory: Inventory): Promise<ResolverPort>;
}

export interface ImpactRequest {
  base: Revision;
  head: Revision;
}

export interface ImpactResult {
  report: ImpactReport;
  plan: TestPlan;
}

interface Snapshot {
  inventory: Inventory;
  graph: DependencyGraph;
  unresolved: UnresolvedImport[];
}

/**
 * Orchestrates one analysis run (ARCHITECTURE.md §3.5). Takes ports, so tests can inject fakes.
 *
 *   merge-base → diff → graph(base) + graph(head) → seeds (DiffAnalyzer) → reverse BFS over base ∪ head → tests
 *
 * Both graphs are built from git, so base needs no checkout. Facts are memoized by content hash within the run:
 * a file unchanged between base and head is parsed once. (The persistent SQLite cache comes next.)
 */
export class AnalysisPipeline {
  private readonly factsByHash = new Map<string, FileFacts>();

  constructor(readonly deps: PipelineDeps) {}

  async impact({ base, head }: ImpactRequest): Promise<ImpactResult> {
    const { git } = this.deps;
    const mergeBase = await git.mergeBase(base, head);
    const changes = await git.diff(mergeBase, head);

    const before = await this.snapshot(mergeBase);
    const after = await this.snapshot(head);

    const changeSet = analyzeChanges(changes, {
      base: before.graph,
      head: after.graph,
      baseWorkspace: before.inventory.workspace,
      headWorkspace: after.inventory.workspace,
    });
    const impacted = predictImpact(new UnionGraph([after.graph, before.graph]), changeSet.seeds);
    const plan = selectTests(impacted, after.graph, changeSet, after.inventory.workspace);

    return {
      report: {
        base: mergeBase,
        head,
        changedFiles: [...new Set(changes.flatMap((c) => (c.oldPath === undefined ? [c.path] : [c.oldPath, c.path])))].sort(),
        seeds: changeSet.seeds,
        globalTriggers: changeSet.globalTriggers,
        impacted: impacted.sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1)),
        unresolved: after.unresolved,
      },
      plan,
    };
  }

  private async snapshot(rev: Revision): Promise<Snapshot> {
    const inventory = await this.deps.inventory.inventory(rev);
    const facts = await this.parse(rev, inventory.files);
    const resolver = await this.deps.createResolver(rev, inventory);
    const { graph, unresolved } = buildGraph({ inventory, facts, resolver });
    return { inventory, graph, unresolved };
  }

  private async parse(rev: Revision, files: readonly SourceFile[]): Promise<Map<string, FileFacts>> {
    const missing = files.filter((f) => !this.factsByHash.has(f.contentHash));
    if (missing.length > 0) {
      const contents = await this.deps.git.readBlobs(rev, missing.map((f) => f.path));
      const inputs = missing.filter((f) => contents.has(f.path)).map((f) => ({ ...f, content: contents.get(f.path)! }));
      for await (const facts of this.deps.parser.extract(inputs)) this.factsByHash.set(facts.contentHash, facts);
    }
    // Identical content at another path (copies, renames) shares facts; re-stamp the path.
    return new Map(
      files.flatMap((f) => {
        const facts = this.factsByHash.get(f.contentHash);
        return facts ? [[f.path, { ...facts, path: f.path }] as const] : [];
      }),
    );
  }
}

/** Composition root: the only place adapters are instantiated. */
export function createPipeline(cwd: string): AnalysisPipeline {
  const git = new GitService(cwd);
  return new AnalysisPipeline({
    git,
    inventory: new SourceInventory(git, new WorkspaceDiscovery(git)),
    parser: new ASTParser(),
    createResolver: (rev, inventory) => ModuleResolver.load(git, rev, inventory.workspace, inventory.paths),
  });
}
