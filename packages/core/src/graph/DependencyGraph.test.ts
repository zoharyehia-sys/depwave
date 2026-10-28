import { describe, expect, it } from 'vitest';
import { Confidence, type GraphEdge } from '../model/graph.js';
import { nodeId } from '../model/ids.js';
import { DependencyGraph, NO_PACKAGE, UnionGraph } from './DependencyGraph.js';

const f = (path: string) => nodeId.file(path);
const edge = (from: string, to: string, ownerFile = from, kind: GraphEdge['kind'] = 'IMPORTS'): GraphEdge => ({
  from: f(from),
  to: f(to),
  kind,
  confidence: Confidence.certain,
  ownerFile: f(ownerFile),
});
const ids = (edges: Iterable<GraphEdge>) => [...edges].map((e) => `${e.from}>${e.to}`).sort();

describe('DependencyGraph', () => {
  it('indexes edges both ways and ignores duplicates', () => {
    const g = new DependencyGraph();
    g.addEdge(edge('a', 'b'));
    g.addEdge(edge('a', 'b'));
    g.addEdge(edge('c', 'b'));
    expect(g.edgeCount).toBe(2);
    expect(ids(g.inEdges(f('b')))).toEqual(['file:a>file:b', 'file:c>file:b']);
    expect(ids(g.outEdges(f('a')))).toEqual(['file:a>file:b']);
    expect([...g.inEdges(f('nope'))]).toEqual([]);
  });

  it('removes exactly the edges and wildcards a file owns (the incremental primitive)', () => {
    const g = new DependencyGraph();
    g.addEdge(edge('a', 'b'));
    g.addEdge(edge('a', 'c'));
    g.addEdge(edge('d', 'b'));
    g.addWildcardDependency('pkg:x', f('a'));
    expect(g.removeEdgesOwnedBy(f('a'))).toBe(2);
    expect(ids(g.inEdges(f('b')))).toEqual(['file:d>file:b']);
    expect([...g.inEdges(f('c'))]).toEqual([]);
    expect([...g.wildcardDependents('pkg:x')]).toEqual([]);
    expect(g.removeEdgesOwnedBy(f('a'))).toBe(0);
  });

  it('lists files per package through CONTAINS edges', () => {
    const g = new DependencyGraph();
    g.addNode({ id: 'pkg:p', kind: 'package', name: 'p', root: 'p', manifestPath: 'p/package.json' });
    g.addNode({ id: f('p/a.ts'), kind: 'file', path: 'p/a.ts', packageId: 'pkg:p', contentHash: '', isTest: false, hasSideEffects: false });
    g.addEdge({ from: 'pkg:p', to: f('p/a.ts'), kind: 'CONTAINS', confidence: Confidence.certain, ownerFile: f('p/a.ts') });
    expect([...g.filesOf('pkg:p')].map((n) => n.path)).toEqual(['p/a.ts']);
    // Regression: files outside every package have no CONTAINS edge, so triggers scoped to NO_PACKAGE seeded nothing.
    g.addNode({ id: f('scripts/x.ts'), kind: 'file', path: 'scripts/x.ts', contentHash: '', isTest: false, hasSideEffects: false });
    expect([...g.filesOf(NO_PACKAGE)].map((n) => n.path)).toEqual(['scripts/x.ts']);
  });
});

describe('UnionGraph', () => {
  it('merges dependents and wildcards from every graph without duplicates, preferring the first for nodes', () => {
    const head = new DependencyGraph();
    const base = new DependencyGraph();
    head.addEdge(edge('a', 'x'));
    base.addEdge(edge('a', 'x'));
    base.addEdge(edge('old', 'x'));
    head.addWildcardDependency('pkg:p', f('w1'));
    base.addWildcardDependency('pkg:p', f('w1'));
    base.addWildcardDependency('pkg:p', f('w2'));
    head.addNode({ id: f('x'), kind: 'file', path: 'x', contentHash: 'head', isTest: false, hasSideEffects: false });
    base.addNode({ id: f('x'), kind: 'file', path: 'x', contentHash: 'base', isTest: false, hasSideEffects: false });

    const union = new UnionGraph([head, base]);
    expect(ids(union.inEdges(f('x')))).toEqual(['file:a>file:x', 'file:old>file:x']);
    expect([...union.wildcardDependents('pkg:p')]).toEqual([f('w1'), f('w2')]);
    expect(union.node(f('x'))).toMatchObject({ contentHash: 'head' });
  });
});
