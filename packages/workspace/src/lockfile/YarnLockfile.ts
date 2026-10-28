import { dirOf, stripBom, toPosixPath } from '@depwave/core';
import { parse as parseYaml } from 'yaml';
import { isEntry, json, Unsupported, type LockEntry, type LockGraph, type LockNode } from './LockGraph.js';

/** Berry lists optional dependencies under `dependencies` (marked in `dependenciesMeta`); peers come from the parent. */
const DEP_FIELDS = ['dependencies', 'optionalDependencies'] as const;
const WORKSPACE = /^(.+?)@workspace:(.+)$/;

type Entry = Record<string, unknown>;

/**
 * Yarn berry (2+) `yarn.lock`: YAML whose keys are comma-separated descriptors (`ms@npm:^2.1.2, ms@npm:^2.1.3`)
 * sharing one resolution (`ms@npm:2.1.3`). Workspaces are entries resolved as `name@workspace:<path>`.
 * Yarn classic (v1) has no workspace entries, so it can't be narrowed.
 */
export function parseYarnLockfile(text: string, path: string, side: string): LockGraph {
  const source = stripBom(text);
  if (/^# yarn lockfile v1\b/m.test(source)) throw new Unsupported('yarn classic (v1) lockfiles are not analyzed (no workspace entries)');
  let data: unknown;
  try {
    data = parseYaml(source, { maxAliasCount: -1 });
  } catch (error) {
    throw new Unsupported(`could not parse ${path} at ${side} (${(error as Error).message.split('\n')[0]})`);
  }
  if (!isEntry(data) || !isEntry(data.__metadata)) throw new Unsupported(`${path} at ${side} is not a yarn berry lockfile (no __metadata)`);

  const resolutionOf = new Map<string, string>();
  const entries = new Map<string, Entry>();
  for (const [key, entry] of Object.entries(data)) {
    if (key === '__metadata' || !isEntry(entry) || typeof entry.resolution !== 'string') continue;
    entries.set(entry.resolution, entry);
    for (const descriptor of key.split(',')) resolutionOf.set(descriptor.trim(), entry.resolution);
  }

  const depsOf = (entry: Entry): string[] =>
    DEP_FIELDS.flatMap((field) => {
      const deps = entry[field];
      if (!isEntry(deps)) return [];
      return Object.entries(deps).flatMap(([name, range]) => {
        // Yarn 4 writes `npm:^2.1.2`; yarn 2/3 wrote the bare range `^2.1.2` against an `ms@npm:^2.1.2` key. A workspace
        // sibling resolves to an importer, not a node, so it leads nowhere: the workspace graph covers those.
        const resolution = resolutionOf.get(`${name}@${String(range)}`) ?? resolutionOf.get(`${name}@npm:${String(range)}`);
        return resolution === undefined ? [] : [resolution];
      });
    });

  const lockDir = dirOf(path);
  const importers = new Map<string, LockEntry>();
  const nodes = new Map<string, LockNode>();
  for (const [resolution, entry] of entries) {
    const workspace = WORKSPACE.exec(resolution);
    if (workspace) {
      const where = workspace[2] === '.' ? '' : workspace[2]!;
      const dir = toPosixPath(lockDir === '' ? where : where === '' ? lockDir : `${lockDir}/${where}`);
      importers.set(dir, { json: json(entry), deps: depsOf(entry) });
      continue;
    }
    const at = resolution.indexOf('@', 1);
    nodes.set(resolution, {
      name: at === -1 ? resolution : resolution.slice(0, at),
      version: typeof entry.version === 'string' ? entry.version : resolution.slice(at + 1),
      json: json(entry),
      deps: depsOf(entry),
    });
  }
  return { format: `v${String(data.__metadata.version ?? '?')}`, global: new Map([['__metadata', json(data.__metadata)]]), importers, nodes };
}
