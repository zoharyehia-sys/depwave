import { baseNameOf, stripBom, type LockfileDiff } from '@depwave/core';
import { parse as parseYaml } from 'yaml';

/**
 * Any lockfile format, reduced to what impact needs: who depends on what, and what each entry pins. Each parser
 * (pnpm, npm, yarn) builds one; `diffLockGraphs` applies the same soundness rules to all of them.
 */
export interface LockGraph {
  /** e.g. `v9`. A format change selects everything. */
  format: string;
  /** Sections that affect every install (settings, overrides, metadata...), as JSON by key. */
  global: Map<string, string>;
  /** The package manager pinned in the lockfile itself (pnpm 11+ env document). */
  packageManager?: { json: string; label: string };
  /** Workspace importers by repo-relative directory ('' = root). */
  importers: Map<string, LockEntry>;
  /** Installed packages by a key unique within the lockfile. */
  nodes: Map<string, LockNode>;
}

export interface LockEntry {
  /** Everything the lockfile pins for this entry, as JSON: any difference counts as a change. */
  json: string;
  /** Keys of the nodes it depends on (workspace links excluded: the workspace graph covers those). */
  deps: string[];
}

export interface LockNode extends LockEntry {
  /** Package name as code imports it (an npm alias folder name, not the aliased package). */
  name: string;
  version: string;
}

export interface Layout {
  /** Set when node_modules is flat for everything (shamefully-hoist, node-linker=hoisted): names the setting. */
  everything?: string;
  /** Packages hoisted to the root, where every package can load them: a change to one selects everything. */
  publicly(name: string): boolean;
  /**
   * npm, yarn's node-modules linker: every dependency is hoisted, so code can import packages its manifest never
   * declared. Packages whose code imports a changed package (or anything depending on one) are affected too.
   */
  hoistsAll: boolean;
}

export class Unsupported extends Error {}

/**
 * pnpm ≤ 9 hoists these to the root node_modules, where every package can load them without declaring them, and
 * tools load them by name from config. Kept for every format and version: over-selecting on an eslint bump is cheap.
 */
const DEFAULT_PUBLIC_HOIST = ['*eslint*', '*prettier*'];

/**
 * A node is "changed" when its entry differs between base and head (or exists on one side only). An importer is
 * affected when its own entry differs, or a changed node is reachable from it at head.
 *
 * Head reachability is enough, also for removals: on any base path from an unchanged importer to a changed node, the
 * FIRST changed node is reachable at head too, because every node before it is unchanged and so has the same edges.
 */
export function diffLockGraphs(path: string, base: LockGraph, head: LockGraph, layout: Layout): LockfileDiff {
  if (base.format !== head.format) return { kind: 'all', reason: `the lockfile format changed (${base.format} → ${head.format})` };
  const pmBase = base.packageManager;
  const pmHead = head.packageManager;
  if ((pmBase?.json ?? '') !== (pmHead?.json ?? '')) {
    const [was, now] = [pmBase?.label ?? 'unpinned', pmHead?.label ?? 'unpinned'];
    return { kind: 'all', reason: was !== now ? `the package manager changed (${was} → ${now})` : "the package manager's config dependencies changed" };
  }
  for (const key of union([...base.global.keys()], [...head.global.keys()])) {
    if (base.global.get(key) !== head.global.get(key)) return { kind: 'all', reason: `the lockfile's \`${key}\` section changed` };
  }

  const changed = new Set<string>();
  for (const key of union([...base.nodes.keys()], [...head.nodes.keys()])) {
    if (base.nodes.get(key)?.json !== head.nodes.get(key)?.json) changed.add(key);
  }
  const changes = describeChanges(base, head, changed);
  const names = (key: string) => (base.nodes.get(key) ?? head.nodes.get(key))!.name;
  if (changed.size > 0 && layout.everything) return { kind: 'all', reason: `node_modules is hoisted (${layout.everything}), so every package can load every dependency` };
  const hoisted = [...changed].map(names).find((name) => layout.publicly(name));
  if (hoisted !== undefined) return { kind: 'all', reason: `${hoisted} changed, and it is hoisted to the root node_modules, where every package can load it` };

  const importers: string[] = [];
  for (const dir of union([...base.importers.keys()], [...head.importers.keys()])) {
    const importer = head.importers.get(dir);
    if (base.importers.get(dir)?.json !== importer?.json || (importer !== undefined && reaches(head, importer, changed))) importers.push(dir);
  }
  return {
    kind: 'importers',
    importers: importers.sort(),
    changes,
    ...(layout.hoistsAll ? { hoisted: dependentsOf(changed, [base, head]) } : {}),
  };
}

/** True when any node reachable from the entry is in `changed`. */
function reaches(lock: LockGraph, entry: LockEntry, changed: ReadonlySet<string>): boolean {
  if (changed.size === 0) return false;
  const seen = new Set<string>(entry.deps);
  const queue = [...entry.deps];
  while (queue.length > 0) {
    const key = queue.pop()!;
    if (changed.has(key)) return true;
    for (const dep of lock.nodes.get(key)?.deps ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return false;
}

/** Names of the changed nodes and of every node that (transitively) depends on one, on either side. */
function dependentsOf(changed: ReadonlySet<string>, locks: readonly LockGraph[]): string[] {
  const names = new Set<string>();
  for (const lock of locks) {
    const dependents = new Map<string, string[]>();
    for (const [key, node] of lock.nodes) for (const dep of node.deps) dependents.set(dep, [...(dependents.get(dep) ?? []), key]);
    const queue = [...changed].filter((key) => lock.nodes.has(key));
    const seen = new Set(queue);
    while (queue.length > 0) {
      const key = queue.pop()!;
      names.add(lock.nodes.get(key)!.name);
      for (const parent of dependents.get(key) ?? []) {
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
  }
  return [...names].sort();
}

/** Version changes per package name, for humans. Nodes whose versions didn't change (new deps below) aren't listed. */
function describeChanges(base: LockGraph, head: LockGraph, changed: ReadonlySet<string>): string[] {
  const versions = (lock: LockGraph) => {
    const byName = new Map<string, Set<string>>();
    for (const key of changed) {
      const node = lock.nodes.get(key);
      if (!node) continue;
      byName.set(node.name, (byName.get(node.name) ?? new Set()).add(node.version));
    }
    return byName;
  };
  const before = versions(base);
  const after = versions(head);
  const out: string[] = [];
  for (const name of union([...before.keys()], [...after.keys()]).sort()) {
    const was = [...(before.get(name) ?? [])].sort();
    const now = [...(after.get(name) ?? [])].sort();
    if (json(was) === json(now)) continue;
    if (was.length === 0) out.push(`+ ${name} ${now.join(', ')}`);
    else if (now.length === 0) out.push(`- ${name} ${was.join(', ')}`);
    else out.push(`${name} ${was.join(', ')} → ${now.join(', ')}`);
  }
  return out;
}

/**
 * Hoisting settings from `.npmrc` (`key=value`), pnpm-workspace.yaml (pnpm 10 camelCase) and `.yarnrc.yml`.
 * `hoistsAll` is the format's default (npm: always); yarn's `nodeLinker: node-modules` and `pnpMode: loose` turn it on.
 */
export function readLayout(config: ReadonlyMap<string, string>, hoistsAll: boolean): Layout {
  const patterns = [...DEFAULT_PUBLIC_HOIST];
  let everything: string | undefined;
  let flat = hoistsAll;
  for (const [path, text] of config) {
    if (baseNameOf(path) === '.npmrc') {
      for (const line of stripBom(text).split(/\r?\n/)) {
        const match = /^\s*([\w-]+)(\[\])?\s*=\s*(.*?)\s*$/.exec(line);
        if (!match || line.trimStart().startsWith('#') || line.trimStart().startsWith(';')) continue;
        const [, key, , value = ''] = match;
        if (key === 'shamefully-hoist' && value === 'true') everything = `shamefully-hoist in ${path}`;
        if (key === 'node-linker' && value === 'hoisted') everything = `node-linker=hoisted in ${path}`;
        if (key === 'public-hoist-pattern' && value !== '') patterns.push(value);
      }
      continue;
    }
    let yaml: unknown;
    try {
      yaml = parseYaml(stripBom(text));
    } catch {
      continue; // WorkspaceDiscovery / the toolchain trigger report a broken config
    }
    if (!isEntry(yaml)) continue;
    if (yaml.shamefullyHoist === true) everything = `shamefullyHoist in ${path}`;
    if (yaml.nodeLinker === 'hoisted') everything = `nodeLinker: hoisted in ${path}`;
    if (yaml.nodeLinker === 'node-modules' || yaml.pnpMode === 'loose') flat = true;
    if (Array.isArray(yaml.publicHoistPattern)) patterns.push(...yaml.publicHoistPattern.filter((p): p is string => typeof p === 'string'));
  }
  const include = patterns.filter((p) => !p.startsWith('!')).map(glob);
  const exclude = patterns.filter((p) => p.startsWith('!')).map((p) => glob(p.slice(1)));
  return {
    ...(everything ? { everything } : {}),
    publicly: (name) => include.some((re) => re.test(name)) && !exclude.some((re) => re.test(name)),
    hoistsAll: flat,
  };
}

const glob = (pattern: string): RegExp => new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
export const isEntry = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const json = (value: unknown): string => JSON.stringify(value ?? null);
export const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];
