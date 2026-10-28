import { describe, expect, it } from 'vitest';
import { Confidence, type EdgeKind } from '../model/graph.js';
import { nodeId } from '../model/ids.js';
import { findImportCycles } from './cycles.js';
import { DependencyGraph } from './DependencyGraph.js';

/** `a>b` imports; `a=>b` type-only; `a~>b` dynamic import; `a*>b` re-export. */
function graphOf(...specs: string[]): DependencyGraph {
  const g = new DependencyGraph();
  const file = (path: string) => {
    const id = nodeId.file(path);
    if (!g.node(id)) g.addNode({ id, kind: 'file', path, contentHash: path, isTest: false, hasSideEffects: false });
    return id;
  };
  for (const spec of specs) {
    const [, from, arrow, to] = /^(.+?)(=>|~>|\*>|>)(.+)$/.exec(spec)!;
    const kind: EdgeKind = arrow === '~>' ? 'DYNAMIC_IMPORT' : arrow === '*>' ? 'RE_EXPORTS' : 'IMPORTS';
    g.addEdge({ from: file(from!), to: file(to!), kind, confidence: Confidence.certain, ownerFile: file(from!), ...(arrow === '=>' ? { typeOnly: true } : {}) });
  }
  return g;
}

describe('findImportCycles', () => {
  it('finds each strongly connected component once, with a loop through it', () => {
    const g = graphOf('a>b', 'b>c', 'c>a', 'd>a', 'x>y', 'y*>x', 'e>f');
    expect(findImportCycles(g)).toEqual([
      { files: ['a', 'b', 'c'], loop: ['a', 'b', 'c', 'a'] },
      { files: ['x', 'y'], loop: ['x', 'y', 'x'] },
    ]);
  });

  it('reports the shortest loop when a component has several', () => {
    const g = graphOf('a>b', 'b>c', 'c>d', 'd>a', 'b>a');
    expect(findImportCycles(g)).toEqual([{ files: ['a', 'b', 'c', 'd'], loop: ['a', 'b', 'a'] }]);
  });

  it('ignores type-only imports unless asked, dynamic imports always, and self-imports', () => {
    const g = graphOf('a>b', 'b=>a', 'c>d', 'd~>c', 'e>e');
    expect(findImportCycles(g)).toEqual([]);
    expect(findImportCycles(g, { includeTypeOnly: true })).toEqual([{ files: ['a', 'b'], loop: ['a', 'b', 'a'] }]);
  });

  it('only follows edges between files', () => {
    const g = graphOf('a>b');
    const span = { startLine: 1, endLine: 1, startByte: 0, endByte: 1 };
    g.addNode({ id: nodeId.symbol('b', 'f'), kind: 'symbol', fileId: nodeId.file('b'), name: 'f', symbolKind: 'function', exported: true, span, bodyHash: 'h' });
    g.addEdge({ from: nodeId.file('b'), to: nodeId.symbol('b', 'f'), kind: 'PART_OF', confidence: Confidence.certain, ownerFile: nodeId.file('b') });
    g.addEdge({ from: nodeId.symbol('b', 'f'), to: nodeId.file('a'), kind: 'IMPORTS', confidence: Confidence.certain, ownerFile: nodeId.file('b') });
    expect(findImportCycles(g)).toEqual([]);
  });

  it('handles a cycle through 100,000 files without overflowing the stack', () => {
    const n = 100_000;
    const g = graphOf(...Array.from({ length: n }, (_, i) => `f${String(i).padStart(6, '0')}>f${String((i + 1) % n).padStart(6, '0')}`));
    const [cycle] = findImportCycles(g);
    expect(cycle?.files).toHaveLength(n);
    expect(cycle?.loop).toHaveLength(n + 1);
  });
});
