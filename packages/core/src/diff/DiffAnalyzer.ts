import { NO_PACKAGE, type DependencyGraph } from '../graph/DependencyGraph.js';
import type { ChangeSet, FileChange, GlobalTrigger } from '../model/changes.js';
import { nodeId, type NodeId } from '../model/ids.js';
import type { Workspace } from '../model/workspace.js';
import { baseNameOf, dirOf, isWithin } from '../paths.js';

export interface DiffContext {
  base: DependencyGraph;
  head: DependencyGraph;
  baseWorkspace: Workspace;
  headWorkspace: Workspace;
}

const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb']);
const WORKSPACE_CONFIGS = new Set(['pnpm-workspace.yaml', 'nx.json', 'turbo.json', 'lerna.json', 'depwave.config.json']);
/** Config files that change how everything under their directory compiles or runs. */
const DIRECTORY_CONFIG = /^(tsconfig.*\.json|jsconfig.*\.json|(vitest|vite|jest)\.(config|workspace)\.[cm]?[jt]s|babel\.config\.[cm]?js|\.babelrc(\.json)?)$/;

/**
 * File-level change analysis: every changed path (both sides of a rename) is a seed, plus global triggers for files
 * whose effect isn't visible as an import edge:
 *
 *   lockfile, workspace config, root package.json   → everything
 *   tsconfig / test-runner / babel config in dir D  → every file under D
 *   a workspace package's manifest                  → that package and every package that (transitively) depends on it
 *
 * Seeds come from BOTH graphs, so a deleted file seeds its old dependents and an added one its new dependents.
 */
export function analyzeChanges(changes: readonly FileChange[], ctx: DiffContext): ChangeSet {
  const seeds = new Set<NodeId>();
  const triggers: GlobalTrigger[] = [];
  const allFiles = [...new Set([...ctx.head.nodes('file'), ...ctx.base.nodes('file')].map((f) => f.path))];

  const seedFilesWhere = (predicate: (path: string) => boolean) => {
    for (const path of allFiles) if (predicate(path)) seeds.add(nodeId.file(path));
  };

  for (const change of changes) {
    for (const path of change.oldPath === undefined ? [change.path] : [change.path, change.oldPath]) {
      const id = nodeId.file(path);
      if (ctx.head.node(id) || ctx.base.node(id)) seeds.add(id);

      const trigger = classify(path, ctx);
      if (!trigger) continue;
      triggers.push(trigger);
      if (trigger.scope === undefined) {
        seedFilesWhere(() => true);
      } else if (trigger.kind === 'package-manifest') {
        const scope = new Set(trigger.scope);
        for (const graph of [ctx.head, ctx.base]) {
          for (const pkg of scope) for (const file of graph.filesOf(pkg)) seeds.add(file.id);
        }
      } else {
        seedFilesWhere((p) => isWithin(p, dirOf(path)));
      }
    }
  }

  return { seeds: [...seeds].sort(), globalTriggers: triggers };
}

function classify(path: string, ctx: DiffContext): GlobalTrigger | undefined {
  const name = baseNameOf(path);
  const dir = dirOf(path);

  if (LOCKFILES.has(name)) return { kind: 'lockfile', path };
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
