import type { ExportedGraph } from '@depwave/core';
import { describe, expect, it } from 'vitest';
import { renderDot, renderMermaid } from './GraphReporter.js';

const files: ExportedGraph = {
  level: 'file',
  package: 'ui',
  nodes: [
    { id: 'ui/"odd" name.ts', kind: 'file', inCycle: true },
    { id: 'ui/b.test.ts', kind: 'file', test: true, inCycle: true },
    { id: 'utils', kind: 'package' },
  ],
  edges: [
    { from: 'ui/"odd" name.ts', to: 'ui/b.test.ts', kind: 'imports' },
    { from: 'ui/b.test.ts', to: 'ui/"odd" name.ts', kind: 'type' },
    { from: 'ui/b.test.ts', to: 'utils', kind: 'dynamic' },
  ],
};

describe('renderMermaid', () => {
  it('uses generated ids with escaped labels, edge styles, and stacked classes', () => {
    expect(renderMermaid(files)).toBe(
      [
        'flowchart LR',
        '  n0["ui/#quot;odd#quot; name.ts"]',
        '  n1["ui/b.test.ts"]',
        '  n2(["utils"])',
        '  n0 --> n1',
        '  n1 -. type .-> n0',
        '  n1 -. dynamic .-> n2',
        '  classDef test fill:#e8f4ea,stroke:#3a7d44',
        '  class n1 test',
        '  classDef cycle stroke:#d33,stroke-width:3px',
        '  class n0,n1 cycle',
        '',
      ].join('\n'),
    );
  });

  it('draws packages as boxes at the package level', () => {
    expect(renderMermaid({ level: 'package', nodes: [{ id: '@a/b', kind: 'package' }], edges: [] })).toBe('flowchart LR\n  n0["@a/b"]\n');
  });
});

describe('renderDot', () => {
  it('quotes ids, escapes quotes and backslashes, and styles nodes and edges', () => {
    const dot = renderDot({ ...files, nodes: [...files.nodes, { id: 'a\\b', kind: 'file' }] });
    expect(dot).toContain('  "ui/\\"odd\\" name.ts" [color="#dd3333", penwidth=2];');
    expect(dot).toContain('  "ui/b.test.ts" [style=filled, fillcolor="#e8f4ea", color="#dd3333", penwidth=2];');
    expect(dot).toContain('  "utils" [shape=component];');
    expect(dot).toContain('  "a\\\\b";');
    expect(dot).toContain('  "ui/b.test.ts" -> "utils" [style=dashed, label="dynamic"];');
    expect(dot).toMatch(/^digraph depwave \{\n {2}rankdir=LR;/);
    expect(dot.endsWith('}\n')).toBe(true);
  });
});
