import type { ExportedEdge, ExportedGraph } from '@depwave/core';

/**
 * Mermaid flowchart. Ids are generated (`n0`, `n1`, …) because package names and paths contain characters Mermaid
 * can't take as ids; the real name is the label. Packages a file-level export points out to are drawn as stadiums.
 */
export function renderMermaid(graph: ExportedGraph): string {
  const id = new Map(graph.nodes.map((n, i) => [n.id, `n${i}`]));
  const label = (text: string) => `"${text.replace(/"/g, '#quot;')}"`;
  const lines = ['flowchart LR'];
  for (const node of graph.nodes) {
    const shape = graph.level === 'file' && node.kind === 'package' ? `([${label(node.id)}])` : `[${label(node.id)}]`;
    lines.push(`  ${id.get(node.id)}${shape}`);
  }
  const arrow: Record<ExportedEdge['kind'], string> = { depends: '-->', imports: '-->', dynamic: '-. dynamic .->', type: '-. type .->' };
  for (const edge of graph.edges) lines.push(`  ${id.get(edge.from)} ${arrow[edge.kind]} ${id.get(edge.to)}`);
  // `class` statements, not `:::`: a node can be both a test and in a cycle, and `:::` takes one class.
  const tests = graph.nodes.filter((n) => n.test).map((n) => id.get(n.id));
  const cyclic = graph.nodes.filter((n) => n.inCycle).map((n) => id.get(n.id));
  if (tests.length) lines.push('  classDef test fill:#e8f4ea,stroke:#3a7d44', `  class ${tests.join(',')} test`);
  if (cyclic.length) lines.push('  classDef cycle stroke:#d33,stroke-width:3px', `  class ${cyclic.join(',')} cycle`);
  return `${lines.join('\n')}\n`;
}

/** Graphviz DOT: `depwave graph --format dot | dot -Tsvg > graph.svg`. */
export function renderDot(graph: ExportedGraph): string {
  const quote = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const lines = ['digraph depwave {', '  rankdir=LR;', '  node [shape=box, fontname="Helvetica"];'];
  for (const node of graph.nodes) {
    const attrs: string[] = [];
    if (graph.level === 'file' && node.kind === 'package') attrs.push('shape=component');
    if (node.test) attrs.push('style=filled', 'fillcolor="#e8f4ea"');
    if (node.inCycle) attrs.push('color="#dd3333"', 'penwidth=2');
    lines.push(`  ${quote(node.id)}${attrs.length ? ` [${attrs.join(', ')}]` : ''};`);
  }
  const style: Record<ExportedEdge['kind'], string> = { depends: '', imports: '', dynamic: ' [style=dashed, label="dynamic"]', type: ' [style=dotted, label="type"]' };
  for (const edge of graph.edges) lines.push(`  ${quote(edge.from)} -> ${quote(edge.to)}${style[edge.kind]};`);
  lines.push('}');
  return `${lines.join('\n')}\n`;
}
