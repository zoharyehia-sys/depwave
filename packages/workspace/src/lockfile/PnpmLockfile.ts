import { baseNameOf, dirOf, stripBom, toPosixPath, type LockfileChange, type LockfileDiff, type LockfilePort } from '@depwave/core';
import { parse as parseYaml, parseAllDocuments } from 'yaml';

/**
 * pnpm ≤ 9 hoists these to the root node_modules, where every package can load them without declaring them. Kept for
 * every version (and on top of a configured pattern): over-selecting on an eslint bump is cheap, missing a test is not.
 */
const DEFAULT_PUBLIC_HOIST = ['*eslint*', '*prettier*'];
const IMPORTER_DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
const SNAPSHOT_DEP_FIELDS = ['dependencies', 'optionalDependencies'] as const;
/**
 * Handled per importer. `catalogs` too: a catalog bump shows up as a new `version` in every importer that uses it.
 * Any other top-level change (settings, overrides, patches, checksums...) affects everything.
 */
const PER_IMPORTER_SECTIONS = new Set(['importers', 'packages', 'snapshots', 'catalogs']);
/** pnpm 11+ writes an "env lockfile" document first: the package manager itself and config dependencies. */
const ENV_FIELDS = new Set(['configDependencies', 'packageManagerDependencies']);

type Entry = Record<string, unknown>;

interface Lockfile {
  version: 6 | 9;
  /** The env document(s) (pnpm 11+), as JSON; '' when there are none. */
  env: string;
  /** The pnpm version the env document pins, if any. */
  pnpm: string | undefined;
  top: Entry;
  importers: Record<string, Entry>;
  /** v9 `snapshots` (resolved dependency graph); in v6 the `packages` section plays both roles. */
  snapshots: Record<string, Entry>;
  /** v9 `packages` (integrity, engines...), keyed without the peer suffix. Empty for v6. */
  packages: Record<string, Entry>;
}

class Unsupported extends Error {}

/**
 * Narrows a `pnpm-lock.yaml` change to the workspace importers whose resolved dependency closure changed.
 *
 * A package entry is "changed" when its snapshot or metadata differs between base and head (or exists on one side
 * only). An importer is affected when its own entry differs, or a changed entry is reachable from it at head.
 *
 * Head reachability is enough, also for removals: on any base path from an unchanged importer to a changed entry,
 * the FIRST changed entry is reachable at head too, because every entry before it is unchanged and so has the same
 * edges. (A version bump deep in the tree also changes the snapshot of every package on the way up.)
 *
 * Everything the lockfile can't attribute to one importer falls back to `all`, with the reason.
 */
export class PnpmLockfileAnalyzer implements LockfilePort {
  supports(path: string): boolean {
    return baseNameOf(path) === 'pnpm-lock.yaml';
  }

  layoutConfigPaths(path: string): string[] {
    const dir = dirOf(path);
    const join = (name: string) => (dir === '' ? name : `${dir}/${name}`);
    return [...new Set(['.npmrc', 'pnpm-workspace.yaml', join('.npmrc'), join('pnpm-workspace.yaml')])];
  }

  diff({ path, before, after, layoutConfig }: LockfileChange): LockfileDiff {
    if (before === undefined) return { kind: 'all', reason: `${path} was added` };
    if (after === undefined) return { kind: 'all', reason: `${path} was deleted` };
    try {
      return diffLockfiles(path, read(before, path, 'base'), read(after, path, 'head'), hoisting(layoutConfig));
    } catch (error) {
      if (error instanceof Unsupported) return { kind: 'all', reason: error.message };
      throw error;
    }
  }
}

function diffLockfiles(path: string, base: Lockfile, head: Lockfile, hoist: Hoisting): LockfileDiff {
  if (base.version !== head.version) return { kind: 'all', reason: `the lockfile format changed (v${base.version} → v${head.version})` };
  if (base.env !== head.env) {
    const what = base.pnpm !== head.pnpm ? `pnpm ${base.pnpm ?? '(unpinned)'} → ${head.pnpm ?? '(unpinned)'}` : "pnpm's config dependencies changed";
    return { kind: 'all', reason: `the package manager changed (${what})` };
  }
  for (const key of union(Object.keys(base.top), Object.keys(head.top))) {
    if (!PER_IMPORTER_SECTIONS.has(key) && json(base.top[key]) !== json(head.top[key])) {
      return { kind: 'all', reason: `the lockfile's \`${key}\` section changed` };
    }
  }

  const changed = new Set<string>();
  for (const key of union(Object.keys(base.snapshots), Object.keys(head.snapshots))) {
    if (entryJson(base, key) !== entryJson(head, key)) changed.add(key);
  }
  const changes = describeChanges(base, head, changed);
  if (changed.size > 0 && hoist.everything) return { kind: 'all', reason: `node_modules is hoisted (${hoist.everything}), so every package can load every dependency` };
  const hoisted = [...changed].map((key) => parseKey(key, base.version).name).find((name) => hoist.publicly(name));
  if (hoisted !== undefined) return { kind: 'all', reason: `${hoisted} changed, and pnpm hoists it to the root node_modules, where every package can load it` };

  const lockDir = dirOf(path);
  const importers: string[] = [];
  for (const key of union(Object.keys(base.importers), Object.keys(head.importers))) {
    const importer = head.importers[key];
    const affected = json(base.importers[key]) !== json(importer) || (importer !== undefined && reaches(head, importer, changed));
    if (affected) importers.push(toPosixPath(key === '.' ? lockDir : lockDir === '' ? key : `${lockDir}/${key}`));
  }
  return { kind: 'importers', importers: importers.sort(), changes };
}

function read(text: string, path: string, side: string): Lockfile {
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
  const envFields = { env: env.length > 0 ? json(env) : '', pnpm: pinnedPnpm(env) };
  const major = Number.parseInt(String(data.lockfileVersion ?? ''), 10);
  if (major !== 6 && major !== 9) throw new Unsupported(`pnpm lockfileVersion ${String(data.lockfileVersion)} is not analyzed (only 6.x and 9.x)`);
  if (!isEntry(data.importers)) throw new Unsupported(`${path} has no \`importers\` (a single-project lockfile)`);

  const section = (value: unknown) => (isEntry(value) ? (value as Record<string, Entry>) : {});
  return major === 9
    ? { version: 9, ...envFields, top: data, importers: section(data.importers), snapshots: section(data.snapshots), packages: section(data.packages) }
    : { version: 6, ...envFields, top: data, importers: section(data.importers), snapshots: section(data.packages), packages: {} };
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

/** True when any entry reachable from the importer's dependencies is in `changed`. */
function reaches(lock: Lockfile, importer: Entry, changed: ReadonlySet<string>): boolean {
  if (changed.size === 0) return false;
  const seen = new Set<string>();
  const queue: string[] = [];
  const visit = (deps: unknown) => {
    if (!isEntry(deps)) return;
    for (const [name, value] of Object.entries(deps)) {
      // Importers: { specifier, version }. Snapshots: a plain reference string.
      const ref = typeof value === 'string' ? value : isEntry(value) && typeof value.version === 'string' ? value.version : undefined;
      const key = ref === undefined ? undefined : depPath(ref, name, lock.version);
      if (key !== undefined && !seen.has(key)) {
        seen.add(key);
        queue.push(key);
      }
    }
  };

  for (const field of IMPORTER_DEP_FIELDS) visit(importer[field]);
  while (queue.length > 0) {
    const key = queue.pop()!;
    if (changed.has(key)) return true;
    const snapshot = lock.snapshots[key];
    if (snapshot) for (const field of SNAPSHOT_DEP_FIELDS) visit(snapshot[field]);
  }
  return false;
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

const entryJson = (lock: Lockfile, key: string): string =>
  json([lock.snapshots[key] ?? null, lock.version === 9 ? (lock.packages[withoutPeers(key)] ?? null) : null]);

/** Version changes per package name, for humans. Entries whose versions didn't change (new deps below) aren't listed. */
function describeChanges(base: Lockfile, head: Lockfile, changed: ReadonlySet<string>): string[] {
  const versions = (lock: Lockfile) => {
    const byName = new Map<string, Set<string>>();
    for (const key of changed) {
      if (lock.snapshots[key] === undefined) continue;
      const { name, version } = parseKey(key, lock.version);
      let set = byName.get(name);
      if (!set) byName.set(name, (set = new Set()));
      set.add(version);
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

interface Hoisting {
  /** Set when node_modules is flat (shamefully-hoist / node-linker=hoisted): names the setting. */
  everything?: string;
  publicly(name: string): boolean;
}

/** Reads `.npmrc` (`key=value`) and pnpm-workspace.yaml (pnpm 10 camelCase settings). */
function hoisting(config: ReadonlyMap<string, string>): Hoisting {
  const patterns = [...DEFAULT_PUBLIC_HOIST];
  let everything: string | undefined;
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
    } else {
      let yaml: unknown;
      try {
        yaml = parseYaml(stripBom(text));
      } catch {
        continue; // WorkspaceDiscovery reports a broken pnpm-workspace.yaml
      }
      if (!isEntry(yaml)) continue;
      if (yaml.shamefullyHoist === true) everything = `shamefullyHoist in ${path}`;
      if (yaml.nodeLinker === 'hoisted') everything = `nodeLinker: hoisted in ${path}`;
      if (Array.isArray(yaml.publicHoistPattern)) patterns.push(...yaml.publicHoistPattern.filter((p): p is string => typeof p === 'string'));
    }
  }
  const include = patterns.filter((p) => !p.startsWith('!')).map(glob);
  const exclude = patterns.filter((p) => p.startsWith('!')).map((p) => glob(p.slice(1)));
  return {
    ...(everything ? { everything } : {}),
    publicly: (name) => include.some((re) => re.test(name)) && !exclude.some((re) => re.test(name)),
  };
}

const glob = (pattern: string): RegExp => new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
const isEntry = (value: unknown): value is Entry => typeof value === 'object' && value !== null && !Array.isArray(value);
const json = (value: unknown): string => JSON.stringify(value ?? null);
const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];
