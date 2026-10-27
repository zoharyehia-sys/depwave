import { describe, expect, it } from 'vitest';
import { DependencyGraph } from '../graph/DependencyGraph.js';
import { Confidence, type EdgeKind, type GraphEdge } from '../model/graph.js';
import type { ImpactReport } from '../model/impact.js';
import { explainImpact } from './Explain.js';
import { predictImpact } from './ImpactPredictor.js';

function file(g: DependencyGraph, path: string, packageId?: string) {
  g.addNode({ id: `file:${path}`, kind: 'file', path, contentHash: '', isTest: path.includes('.test.'), hasSideEffects: false, ...(packageId ? { packageId } : {}) });
}
function sym(g: DependencyGraph, path: string, name: string, line = 1) {
  g.addNode({ id: `sym:${path}#${name}`, kind: 'symbol', fileId: `file:${path}`, name, symbolKind: 'function', exported: true, span: { startLine: line, endLine: line, startByte: 0, endByte: 0 }, bodyHash: '' });
}
const edge = (from: string, to: string, kind: EdgeKind, extra: Partial<GraphEdge> = {}): GraphEdge => ({ from, to, kind, confidence: Confidence.certain, ownerFile: from, ...extra });

function report(g: DependencyGraph, seeds: string[], changedFiles: string[], globalTriggers: ImpactReport['globalTriggers'] = []): ImpactReport {
  return { base: 'b', head: 'h', granularity: 'symbol', changedFiles, seeds, globalTriggers, impacted: predictImpact(g, seeds), unresolved: [] };
}

describe('explainImpact', () => {
  const g = new DependencyGraph();
  file(g, 'app/a.test.ts', 'pkg:app');
  sym(g, 'app/a.test.ts', '<module>');
  sym(g, 'app/a.ts', 'render', 3);
  sym(g, 'lib/types.ts', 'Props', 7);
  sym(g, 'lib/money.ts', 'format', 12);
  file(g, 'app/other.test.ts', 'pkg:app');
  g.addEdge(edge('file:app/a.test.ts', 'sym:app/a.test.ts#<module>', 'PART_OF'));
  g.addEdge(edge('sym:app/a.test.ts#<module>', 'sym:app/a.ts#render', 'CALLS'));
  g.addEdge(edge('sym:app/a.ts#render', 'sym:lib/money.ts#format', 'CALLS'));
  g.addEdge(edge('sym:app/a.ts#render', 'sym:lib/money.ts#format', 'REFERENCES', { confidence: Confidence.likely })); // parallel, weaker
  g.addEdge(edge('sym:app/a.ts#render', 'sym:lib/types.ts#Props', 'REFERENCES', { typeOnly: true }));

  it('walks from the target to the change, naming the most certain relation of each hop', () => {
    const result = explainImpact('app/a.test.ts', report(g, ['sym:lib/money.ts#format'], ['lib/money.ts']), g);
    expect(result).toEqual({
      kind: 'impacted',
      target: 'app/a.test.ts',
      heuristic: false,
      cause: { kind: 'changed' },
      steps: [
        { id: 'file:app/a.test.ts', path: 'app/a.test.ts' },
        { id: 'sym:app/a.test.ts#<module>', path: 'app/a.test.ts', symbol: '<module>', relation: 'PART_OF', confidence: Confidence.certain },
        { id: 'sym:app/a.ts#render', path: 'app/a.ts', symbol: 'render', line: 3, relation: 'CALLS', confidence: Confidence.certain },
        { id: 'sym:lib/money.ts#format', path: 'lib/money.ts', symbol: 'format', line: 12, relation: 'CALLS', confidence: Confidence.certain },
      ],
    });
  });

  it('marks type-only hops', () => {
    const result = explainImpact('app/a.test.ts', report(g, ['sym:lib/types.ts#Props'], ['lib/types.ts']), g);
    expect(result.kind === 'impacted' && result.steps.at(-1)).toMatchObject({ relation: 'REFERENCES', typeOnly: true });
  });

  it('labels a wildcard hop (no edge exists) as heuristic', () => {
    const w = new DependencyGraph();
    file(w, 'p/plugin.ts', 'pkg:p');
    file(w, 'p/loader.ts', 'pkg:p');
    file(w, 'p/loader.test.ts', 'pkg:p');
    w.addEdge(edge('file:p/loader.test.ts', 'file:p/loader.ts', 'IMPORTS'));
    w.addWildcardDependency('pkg:p', 'file:p/loader.ts');
    const result = explainImpact('p/loader.test.ts', report(w, ['file:p/plugin.ts'], ['p/plugin.ts']), w);
    expect(result).toMatchObject({ kind: 'impacted', heuristic: true });
    expect(result.kind === 'impacted' && result.steps.map((s) => s.relation ?? 'target')).toEqual(['target', 'IMPORTS', 'WILDCARD']);
  });

  it('attributes a seed that is not in the diff to the trigger that covers it', () => {
    const t = new DependencyGraph();
    file(t, 'app/x.test.ts', 'pkg:app');
    const triggers: ImpactReport['globalTriggers'] = [
      { kind: 'package-manifest', path: 'lib/package.json', scope: ['pkg:lib'] }, // other package: doesn't cover it
      { kind: 'package-manifest', path: 'app/package.json', scope: ['pkg:app'] },
    ];
    const result = explainImpact('app/x.test.ts', report(t, ['file:app/x.test.ts'], ['app/package.json', 'lib/package.json'], triggers), t);
    expect(result).toMatchObject({ kind: 'impacted', cause: { kind: 'trigger', triggers: [triggers[1]] } });
  });

  it('distinguishes "not impacted" from "unknown file"', () => {
    const r = report(g, ['sym:lib/money.ts#format'], ['lib/money.ts']);
    expect(explainImpact('app/other.test.ts', r, g)).toEqual({ kind: 'not-impacted', target: 'app/other.test.ts', changedFiles: ['lib/money.ts'] });
    expect(explainImpact('app/typo.test.ts', r, g)).toEqual({ kind: 'unknown', target: 'app/typo.test.ts' });
  });
});
