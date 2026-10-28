import { describe, expect, it } from 'vitest';
import { Confidence, type EdgeKind } from '../model/graph.js';
import { nodeId } from '../model/ids.js';
import { DependencyGraph } from './DependencyGraph.js';
import { exportGraph } from './export.js';

/** Packages `app` → `ui` → `utils`; files in each, plus a cycle inside `ui`. */
function fixture(): DependencyGraph {
  const g = new DependencyGraph();
  for (const name of ['app', 'ui', 'utils']) g.addNode({ id: nodeId.package(name), kind: 'package', name, root: name, manifestPath: `${name}/package.json` });
  const file = (path: string, pkg: string, isTest = false) =>
    g.addNode({ id: nodeId.file(path), kind: 'file', path, contentHash: path, isTest, hasSideEffects: false, packageId: nodeId.package(pkg) });
  const edge = (from: string, to: string, kind: EdgeKind, typeOnly = false) =>
    g.addEdge({ from: from.includes('/') ? nodeId.file(from) : nodeId.package(from), to: to.includes('/') ? nodeId.file(to) : nodeId.package(to), kind, confidence: Confidence.certain, ownerFile: nodeId.file(from), ...(typeOnly ? { typeOnly } : {}) });

  file('app/a.ts', 'app');
  file('ui/b.ts', 'ui');
  file('ui/c.ts', 'ui');
  file('ui/b.test.ts', 'ui', true);
  file('utils/u.ts', 'utils');
  edge('app', 'ui', 'DEPENDS_ON');
  edge('ui', 'utils', 'DEPENDS_ON');
  edge('app/a.ts', 'ui/b.ts', 'IMPORTS');
  edge('ui/b.ts', 'ui/c.ts', 'IMPORTS');
  edge('ui/c.ts', 'ui/b.ts', 'IMPORTS');
  edge('ui/b.ts', 'utils/u.ts', 'IMPORTS', true);
  edge('ui/b.ts', 'utils/u.ts', 'DYNAMIC_IMPORT');
  edge('ui/b.test.ts', 'ui/b.ts', 'IMPORTS');
  return g;
}

describe('exportGraph', () => {
  it('package level: declared workspace dependencies', () => {
    expect(exportGraph(fixture(), { level: 'package' })).toEqual({
      level: 'package',
      nodes: [
        { id: 'app', kind: 'package' },
        { id: 'ui', kind: 'package' },
        { id: 'utils', kind: 'package' },
      ],
      edges: [
        { from: 'app', to: 'ui', kind: 'depends' },
        { from: 'ui', to: 'utils', kind: 'depends' },
      ],
    });
  });

  it('file level: imports by kind (strongest per pair), tests and cycle members marked', () => {
    const exported = exportGraph(fixture(), { level: 'file' });
    expect(exported.nodes).toEqual([
      { id: 'app/a.ts', kind: 'file' },
      { id: 'ui/b.test.ts', kind: 'file', test: true },
      { id: 'ui/b.ts', kind: 'file', inCycle: true },
      { id: 'ui/c.ts', kind: 'file', inCycle: true },
      { id: 'utils/u.ts', kind: 'file' },
    ]);
    expect(exported.edges).toContainEqual({ from: 'ui/b.ts', to: 'utils/u.ts', kind: 'dynamic' }); // dynamic beats type-only
    expect(exported.edges).toHaveLength(5);
  });

  it('file level for one package: imports that leave it point at the target package', () => {
    const exported = exportGraph(fixture(), { level: 'file', package: 'ui' });
    expect(exported.package).toBe('ui');
    expect(exported.nodes.map((n) => n.id)).toEqual(['ui/b.test.ts', 'ui/b.ts', 'ui/c.ts', 'utils']);
    expect(exported.nodes.find((n) => n.id === 'utils')).toEqual({ id: 'utils', kind: 'package' });
    expect(exported.edges).toContainEqual({ from: 'ui/b.ts', to: 'utils', kind: 'dynamic' });
    expect(exported.edges.some((e) => e.from === 'app/a.ts')).toBe(false);
  });

  it('rejects an unknown package', () => {
    expect(() => exportGraph(fixture(), { level: 'file', package: 'nope' })).toThrow('no workspace package named nope');
  });
});
