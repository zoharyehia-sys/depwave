import { dirOf, stripBom, toPosixPath } from '@depwave/core';
import { isEntry, json, Unsupported, type LockEntry, type LockGraph, type LockNode } from './LockGraph.js';

const NODE_DEP_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;
/** Importers (the root and workspaces) also install their devDependencies. */
const IMPORTER_DEP_FIELDS = [...NODE_DEP_FIELDS, 'devDependencies'] as const;
/** `packages` is the graph; `dependencies` is the v1-compatible mirror of it that v2 still writes. */
const PER_ENTRY_SECTIONS = new Set(['packages', 'dependencies']);
const NODE_MODULES = 'node_modules/';

type Entry = Record<string, unknown>;

/**
 * `package-lock.json` / `npm-shrinkwrap.json`, lockfileVersion 2 or 3. `packages` is keyed by install location:
 * `''` is the root, `packages/a` a workspace, `node_modules/x` a hoisted package, `packages/a/node_modules/x` a
 * nested copy. A dependency resolves the way Node resolves it: the nearest `node_modules/<name>` walking up.
 */
export function parseNpmLockfile(text: string, path: string, side: string): LockGraph {
  let data: unknown;
  try {
    data = JSON.parse(stripBom(text));
  } catch (error) {
    throw new Unsupported(`could not parse ${path} at ${side} (${(error as Error).message})`);
  }
  if (!isEntry(data)) throw new Unsupported(`${path} at ${side} is not an npm lockfile`);
  const version = data.lockfileVersion;
  if (version !== 2 && version !== 3) throw new Unsupported(`npm lockfileVersion ${String(version)} is not analyzed (only 2 and 3)`);
  if (!isEntry(data.packages)) throw new Unsupported(`${path} at ${side} has no \`packages\``);
  const packages = data.packages as Record<string, Entry>;

  const lockDir = dirOf(path);
  const depsOf = (from: string, entry: Entry, fields: readonly string[]): string[] =>
    fields.flatMap((field) => {
      const deps = entry[field];
      if (!isEntry(deps)) return [];
      return Object.keys(deps).flatMap((name) => {
        // undefined: not installed (an optional peer, a platform-specific optional). A link to a workspace is kept but
        // leads nowhere: links are not nodes, and the workspace graph covers workspace-to-workspace changes.
        const key = resolveFrom(from, name, packages);
        return key === undefined ? [] : [key];
      });
    });

  const importers = new Map<string, LockEntry>();
  const nodes = new Map<string, LockNode>();
  for (const [key, entry] of Object.entries(packages)) {
    if (!isEntry(entry) || entry.link === true) continue;
    if (!key.includes(NODE_MODULES)) {
      // The root or a workspace (or a `file:` folder outside node_modules).
      const dir = toPosixPath(lockDir === '' ? key : key === '' ? lockDir : `${lockDir}/${key}`);
      importers.set(dir, { json: json(entry), deps: depsOf(key, entry, IMPORTER_DEP_FIELDS) });
    } else {
      nodes.set(key, {
        name: key.slice(key.lastIndexOf(NODE_MODULES) + NODE_MODULES.length),
        version: typeof entry.version === 'string' ? entry.version : '',
        json: json(entry),
        deps: depsOf(key, entry, NODE_DEP_FIELDS),
      });
    }
  }
  const global = new Map(Object.entries(data).filter(([key]) => !PER_ENTRY_SECTIONS.has(key)).map(([key, value]) => [key, json(value)]));
  return { format: `v${version}`, global, importers, nodes };
}

/**
 * Node's lookup from the package installed at `from`: `<from>/node_modules/<name>`, then the same from each parent
 * directory (skipping directories that ARE node_modules), up to the root.
 */
export function resolveFrom(from: string, name: string, packages: Readonly<Record<string, unknown>>): string | undefined {
  let dir = from;
  for (;;) {
    if (!dir.endsWith('node_modules')) {
      const candidate = dir === '' ? `${NODE_MODULES}${name}` : `${dir}/${NODE_MODULES}${name}`;
      if (packages[candidate] !== undefined) return candidate;
    }
    if (dir === '') return undefined;
    dir = parentOf(dir);
  }
}

/** Parent directory; a scoped package folder (`node_modules/@s/n`) counts as one level. */
function parentOf(dir: string): string {
  const slash = dir.lastIndexOf('/');
  if (slash === -1) return '';
  const parent = dir.slice(0, slash);
  return parent.slice(parent.lastIndexOf('/') + 1).startsWith('@') && parent.includes('node_modules/') ? parentOf(parent) : parent;
}
