/**
 * Stable, human-readable node identity. Format: `<prefix>:<path-or-name>[#<member>]`.
 * Interned dense integer indices are a runtime detail of the graph and are never persisted as identity.
 */
export type NodeId = string;

const PREFIXES = {
  package: 'pkg',
  file: 'file',
  symbol: 'sym',
  test: 'test',
  external: 'ext',
  unresolved: 'unresolved',
} as const;

export type IdKind = keyof typeof PREFIXES;

/** Repo-relative POSIX path: forward slashes, no leading `./`, no duplicate or trailing slashes. */
export function toPosixPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/$/, '');
}

export const nodeId = {
  package: (name: string): NodeId => `${PREFIXES.package}:${name}`,
  file: (path: string): NodeId => `${PREFIXES.file}:${toPosixPath(path)}`,
  symbol: (path: string, name: string): NodeId => `${PREFIXES.symbol}:${toPosixPath(path)}#${name}`,
  test: (path: string, name?: string): NodeId =>
    name === undefined ? `${PREFIXES.test}:${toPosixPath(path)}` : `${PREFIXES.test}:${toPosixPath(path)}#${name}`,
  external: (specifier: string): NodeId => `${PREFIXES.external}:${specifier}`,
  unresolved: (fromPath: string, raw: string): NodeId => `${PREFIXES.unresolved}:${toPosixPath(fromPath)}#${raw}`,
};

export interface ParsedNodeId {
  kind: IdKind;
  /** Path for file/symbol/test/unresolved ids, name for package/external ids. */
  target: string;
  member?: string;
}

const KIND_BY_PREFIX = new Map<string, IdKind>(
  Object.entries(PREFIXES).map(([kind, prefix]) => [prefix, kind as IdKind]),
);

const HAS_MEMBER: ReadonlySet<IdKind> = new Set(['symbol', 'test', 'unresolved']);

export function parseNodeId(id: NodeId): ParsedNodeId {
  const colon = id.indexOf(':');
  const kind = colon === -1 ? undefined : KIND_BY_PREFIX.get(id.slice(0, colon));
  if (kind === undefined) throw new Error(`Invalid node id: ${id}`);

  const rest = id.slice(colon + 1);
  // Only path-based ids carry a `#member`; package/external names may legally contain '#'.
  const hash = HAS_MEMBER.has(kind) ? rest.indexOf('#') : -1;
  return hash === -1 ? { kind, target: rest } : { kind, target: rest.slice(0, hash), member: rest.slice(hash + 1) };
}
