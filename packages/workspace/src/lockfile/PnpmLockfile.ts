import { dirOf, stripBom, toPosixPath } from '@depwave/core';
import { parseAllDocuments } from 'yaml';
import { isEntry, json, Unsupported, type LockEntry, type LockGraph, type LockNode } from './LockGraph.js';

const IMPORTER_DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
const SNAPSHOT_DEP_FIELDS = ['dependencies', 'optionalDependencies'] as const;
/**
 * Handled per importer and node. `catalogs` too: a catalog bump shows up as a new `version` in every importer that
 * uses it. Any other top-level section (settings, overrides, patches, checksums...) is global.
 */
const PER_ENTRY_SECTIONS = new Set(['importers', 'packages', 'snapshots', 'catalogs']);
/** pnpm 11+ writes an "env lockfile" document first: the package manager itself and config dependencies. */
const ENV_FIELDS = new Set(['configDependencies', 'packageManagerDependencies']);

type Entry = Record<string, unknown>;

/**
 * `pnpm-lock.yaml` v9 (`snapshots` hold the resolved graph, `packages` the metadata) or v6 (`packages` holds both,
 * keys start with `/`), optionally preceded by the pnpm 11+ env document.
 */
export function parsePnpmLockfile(text: string, path: string, side: string): LockGraph {
  const documents: unknown[] = [];
  for (const document of parseAllDocuments(stripBom(text))) {
    const error = document.errors[0];
    if (error) throw new Unsupported(`could not parse ${path} at ${side} (${error.message.split('\n')[0]})`);
    documents.push(document.toJS({ maxAliasCount: -1 }));
  }
  const env = documents.filter(isEnvDocument);
  const main = documents.filter((d) => !isEnvDocument(d));
  if (main.length !== 1) throw new Unsupported(`${path} at ${side} has ${main.length} lockfile documents (expected 1, plus an optional env document)`);
  const data = main[0];
  if (!isEntry(data)) throw new Unsupported(`${path} at ${side} is not a pnpm lockfile`);
  const major = Number.parseInt(String(data.lockfileVersion ?? ''), 10);
  if (major !== 6 && major !== 9) throw new Unsupported(`pnpm lockfileVersion ${String(data.lockfileVersion)} is not analyzed (only 6.x and 9.x)`);
  if (!isEntry(data.importers)) throw new Unsupported(`${path} has no \`importers\` (a single-project lockfile)`);

  const version = major as 6 | 9;
  const section = (value: unknown) => (isEntry(value) ? (value as Record<string, Entry>) : {});
  const snapshots = section(version === 9 ? data.snapshots : data.packages);
  const packages = version === 9 ? section(data.packages) : {};
  const depsOf = (deps: unknown): string[] =>
    isEntry(deps)
      ? Object.entries(deps).flatMap(([name, value]) => {
          // Importers: { specifier, version }. Snapshots: a plain reference string.
          const ref = typeof value === 'string' ? value : isEntry(value) && typeof value.version === 'string' ? value.version : undefined;
          const key = ref === undefined ? undefined : depPath(ref, name, version);
          return key === undefined ? [] : [key];
        })
      : [];

  const lockDir = dirOf(path);
  const importers = new Map<string, LockEntry>();
  for (const [key, importer] of Object.entries(section(data.importers))) {
    const dir = toPosixPath(key === '.' ? lockDir : lockDir === '' ? key : `${lockDir}/${key}`);
    importers.set(dir, { json: json(importer), deps: IMPORTER_DEP_FIELDS.flatMap((field) => depsOf(importer[field])) });
  }
  const nodes = new Map<string, LockNode>();
  for (const [key, snapshot] of Object.entries(snapshots)) {
    const { name, version: v } = parseKey(key, version);
    nodes.set(key, {
      name,
      version: v,
      json: json([snapshot, version === 9 ? (packages[withoutPeers(key)] ?? null) : null]),
      deps: SNAPSHOT_DEP_FIELDS.flatMap((field) => depsOf(snapshot?.[field])),
    });
  }
  const global = new Map(Object.entries(data).filter(([key]) => !PER_ENTRY_SECTIONS.has(key)).map(([key, value]) => [key, json(value)]));
  const pnpm = pinnedPnpm(env);
  return {
    format: `v${version}`,
    global,
    ...(env.length > 0 ? { packageManager: { json: json(env), label: pnpm === undefined ? 'pnpm (unpinned)' : `pnpm ${pnpm}` } } : {}),
    importers,
    nodes,
  };
}

/**
 * pnpm's `refToRelative`: the snapshot key a dependency reference points to. `link:` (a workspace sibling) points to
 * no snapshot: that package's own changes reach its dependents through the workspace graph instead.
 */
export function depPath(ref: string, name: string, version: 6 | 9): string | undefined {
  if (ref.startsWith('link:')) return undefined;
  if (version === 6) return ref.startsWith('/') || /^[a-z]+:/i.test(ref) ? ref : `/${name}@${ref}`;
  if (ref.startsWith('@')) return ref;
  const at = ref.indexOf('@');
  if (at === -1) return `${name}@${ref}`;
  const colon = ref.indexOf(':');
  const paren = ref.indexOf('(');
  // An alias (`npm:string-width@4.2.3` resolves to `string-width@4.2.3`) already is a key.
  if ((colon === -1 || at < colon) && (paren === -1 || at < paren)) return ref;
  return `${name}@${ref}`;
}

const withoutPeers = (key: string) => (key.includes('(') ? key.slice(0, key.indexOf('(')) : key);

/** `@scope/name@1.2.3(peer@1.0.0)` → { name: '@scope/name', version: '1.2.3' }; v6 keys start with `/`. */
function parseKey(key: string, version: 6 | 9): { name: string; version: string } {
  const bare = withoutPeers(version === 6 && key.startsWith('/') ? key.slice(1) : key);
  const at = bare.indexOf('@', 1);
  return at === -1 ? { name: bare, version: '' } : { name: bare.slice(0, at), version: bare.slice(at + 1) };
}

/** `importers: { .: { packageManagerDependencies, configDependencies } }` and nothing else. */
function isEnvDocument(document: unknown): boolean {
  if (!isEntry(document) || !isEntry(document.importers)) return false;
  const importers = Object.entries(document.importers);
  return importers.length === 1 && importers[0]![0] === '.' && isEntry(importers[0]![1]) && Object.keys(importers[0]![1]).every((k) => ENV_FIELDS.has(k));
}

function pinnedPnpm(env: readonly unknown[]): string | undefined {
  for (const document of env) {
    const root = isEntry(document) && isEntry(document.importers) ? document.importers['.'] : undefined;
    const pnpm = isEntry(root) && isEntry(root.packageManagerDependencies) ? root.packageManagerDependencies.pnpm : undefined;
    if (isEntry(pnpm) && typeof pnpm.version === 'string') return pnpm.version;
  }
  return undefined;
}
