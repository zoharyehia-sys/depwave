import type { GraphView } from '../graph/DependencyGraph.js';
import type { ChangeSet } from '../model/changes.js';
import type { ImpactedNode, TestPlan, TestPlanGroup } from '../model/impact.js';
import type { Workspace, WorkspacePackage } from '../model/workspace.js';

const RUNNERS = ['vitest', 'jest'] as const;
const NO_PACKAGE_GROUP = '(no package)';

/**
 * Projects impact onto test files that exist in the head revision (a deleted test can't run), grouped by package
 * and ordered by score (closest, most certain first) so CI fails fast.
 */
export function selectTests(impacted: readonly ImpactedNode[], head: GraphView, changeSet: ChangeSet, workspace: Workspace): TestPlan {
  const groups = new Map<string, Array<{ path: string; score: number }>>();
  for (const { id, score } of impacted) {
    const node = head.node(id);
    if (node?.kind !== 'file' || !node.isTest) continue;
    const pkg = node.packageId === undefined ? undefined : head.node(node.packageId);
    const name = pkg?.kind === 'package' ? pkg.name : NO_PACKAGE_GROUP;
    let tests = groups.get(name);
    if (!tests) groups.set(name, (tests = []));
    tests.push({ path: node.path, score });
  }

  const byName = new Map(workspace.packages.map((p) => [p.name, p]));
  const root = workspace.packages.find((p) => p.root === '');
  const planGroups: TestPlanGroup[] = [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([packageName, tests]) => ({
      packageName,
      runner: runnerFor(byName.get(packageName), root),
      tests: tests.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1)).map((t) => t.path),
    }));

  return { runAll: changeSet.globalTriggers.some((t) => t.scope === undefined), groups: planGroups };
}

/** The package's own test runner dependency, else the repo root's, else unknown. */
function runnerFor(pkg: WorkspacePackage | undefined, root: WorkspacePackage | undefined): TestPlanGroup['runner'] {
  for (const candidate of [pkg, root]) {
    const runner = RUNNERS.find((r) => candidate?.dependencies.includes(r));
    if (runner) return runner;
  }
  return 'unknown';
}

/** Flat, sorted list of every selected test path. */
export const allTests = (plan: TestPlan): string[] => plan.groups.flatMap((g) => g.tests).sort();
