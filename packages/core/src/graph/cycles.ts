import type { EdgeKind } from '../model/graph.js';
import type { DependencyGraph } from './DependencyGraph.js';

export interface ImportCycle {
  /** The files of one strongly connected component, sorted: each can reach every other through imports. */
  files: string[];
  /** One shortest loop through the component, from its first file back to it: `[a, b, c, a]`. */
  loop: string[];
}

export interface CycleOptions {
  /** Count `import type` edges too. Off by default: they're erased at runtime, so they can't cause load-order bugs. */
  includeTypeOnly?: boolean;
}

/**
 * Edges that load a module when the importer loads. Dynamic `import()` is deferred until called, so a cycle through it
 * can't leave a module half-initialized.
 */
const LOADING_EDGES = new Set<EdgeKind>(['IMPORTS', 'RE_EXPORTS']);

/**
 * File-level import cycles: Tarjan's strongly connected components over the runtime import graph, iterative so a deep
 * chain can't overflow the stack. O(files + edges). Self-imports are ignored. Sorted by first file.
 */
export function findImportCycles(graph: DependencyGraph, options: CycleOptions = {}): ImportCycle[] {
  const next = new Map<string, string[]>();
  for (const file of graph.nodes('file')) {
    const targets = new Set<string>();
    for (const edge of graph.outEdges(file.id)) {
      if (!LOADING_EDGES.has(edge.kind) || (edge.typeOnly && !options.includeTypeOnly)) continue;
      const target = graph.node(edge.to);
      if (target?.kind === 'file' && target.path !== file.path) targets.add(target.path);
    }
    next.set(file.path, [...targets].sort());
  }
  const successors = (path: string) => next.get(path) ?? [];

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;
  const open = (path: string) => {
    index.set(path, counter);
    low.set(path, counter++);
    stack.push(path);
    onStack.add(path);
  };

  for (const root of [...next.keys()].sort()) {
    if (index.has(root)) continue;
    open(root);
    const frames: Array<{ path: string; edge: number }> = [{ path: root, edge: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const out = successors(frame.path);
      if (frame.edge < out.length) {
        const target = out[frame.edge++]!;
        if (!index.has(target)) {
          open(target);
          frames.push({ path: target, edge: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.path, Math.min(low.get(frame.path)!, index.get(target)!));
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) low.set(parent.path, Math.min(low.get(parent.path)!, low.get(frame.path)!));
      if (low.get(frame.path) !== index.get(frame.path)) continue;
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== frame.path);
      if (component.length > 1) components.push(component.sort());
    }
  }

  return components
    .sort((a, b) => (a[0]! < b[0]! ? -1 : 1))
    .map((files) => ({ files, loop: shortestLoop(files[0]!, new Set(files), successors) }));
}

/** Breadth-first from `start`, staying inside the component, until an edge leads back to `start`. */
function shortestLoop(start: string, members: ReadonlySet<string>, successors: (path: string) => readonly string[]): string[] {
  const previous = new Map<string, string>();
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i]!;
    for (const target of successors(path)) {
      if (target === start) {
        const loop = [path];
        while (loop[0] !== start) loop.unshift(previous.get(loop[0]!)!);
        return [...loop, start];
      }
      if (members.has(target) && !previous.has(target)) {
        previous.set(target, path);
        queue.push(target);
      }
    }
  }
  return [start]; // unreachable for a strongly connected component
}
