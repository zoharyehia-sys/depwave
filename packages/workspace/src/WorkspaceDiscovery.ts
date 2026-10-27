import { stripBom, type GitPort, type Revision, type TrackedFile, type Workspace, type WorkspacePackage, type WorkspacePort, type WorkspaceTool } from '@depwave/core';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import { baseOf, dirOf, joinPath } from './paths.js';

export class WorkspaceError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'WorkspaceError';
  }
}

interface PackageJson {
  name?: string;
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface NxProjectJson {
  name?: string;
  implicitDependencies?: string[];
}

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
const ROOT_CONFIGS = ['package.json', 'pnpm-workspace.yaml', 'nx.json', 'turbo.json'];

/**
 * Finds packages from workspace config at any revision: tracked paths come from git, file contents from one batched
 * read. Nothing touches the filesystem except WORKTREE reads, so the base commit's layout is analyzed as it was.
 */
export class WorkspaceDiscovery implements WorkspacePort {
  constructor(private readonly git: GitPort) {}

  async discover(rev: Revision, tracked?: readonly TrackedFile[]): Promise<Workspace> {
    const files = tracked ?? (await this.git.listTracked(rev));
    const paths = new Set(files.map((f) => f.path));
    const configs = await this.git.readBlobs(rev, ROOT_CONFIGS.filter((p) => paths.has(p)));
    const rootManifest = parseJson<PackageJson>(configs, 'package.json');

    const tools: WorkspaceTool[] = [];
    let patterns: string[] = [];
    const pnpmConfig = configs.get('pnpm-workspace.yaml');
    if (pnpmConfig !== undefined) {
      // pnpm ignores package.json `workspaces` entirely, so only one source of patterns applies.
      tools.push('pnpm');
      patterns = pnpmPatterns(pnpmConfig);
    } else if (rootManifest?.workspaces) {
      tools.push(paths.has('yarn.lock') ? 'yarn' : 'npm');
      patterns = npmPatterns(rootManifest.workspaces);
    }
    const nx = configs.has('nx.json');
    if (nx) tools.push('nx');
    if (configs.has('turbo.json')) tools.push('turbo');

    const isWorkspaceDir = createMatcher(patterns);
    const packageDirs = new Set<string>();
    const projectDirs = new Set<string>();
    if (rootManifest) packageDirs.add('');
    for (const { path } of files) {
      if (path.split('/').includes('node_modules')) continue;
      const dir = dirOf(path);
      const name = baseOf(path);
      if (name === 'package.json' && dir !== '' && isWorkspaceDir(dir)) packageDirs.add(dir);
      // Nx projects are defined by project.json wherever it lives, with or without a package.json.
      if (nx && name === 'project.json') projectDirs.add(dir);
    }

    // An Nx project's own package.json counts even when no workspace glob covers its directory.
    for (const dir of projectDirs) if (paths.has(joinPath(dir, 'package.json'))) packageDirs.add(dir);

    const dirs = [...new Set([...packageDirs, ...projectDirs])].sort();
    const manifests = await this.git.readBlobs(rev, [
      ...[...packageDirs].map((d) => joinPath(d, 'package.json')),
      ...[...projectDirs].map((d) => joinPath(d, 'project.json')),
    ]);

    const packages = dirs.map((dir) => toPackage(dir, manifests, packageDirs.has(dir), projectDirs.has(dir)));
    const warnings = duplicateNameWarnings(packages);
    return warnings.length > 0 ? { tools, packages, warnings } : { tools, packages };
  }
}

function toPackage(dir: string, manifests: Map<string, string>, hasPackageJson: boolean, hasProject: boolean): WorkspacePackage {
  const pkgPath = joinPath(dir, 'package.json');
  const projectPath = joinPath(dir, 'project.json');
  const pkg = hasPackageJson ? parseJson<PackageJson>(manifests, pkgPath) : undefined;
  const project = hasProject ? parseJson<NxProjectJson>(manifests, projectPath) : undefined;

  const dependencies = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) for (const dep of Object.keys(pkg?.[field] ?? {})) dependencies.add(dep);
  for (const dep of project?.implicitDependencies ?? []) if (!dep.startsWith('!')) dependencies.add(dep);

  return {
    // Unnamed packages still need a stable identity: fall back to their path ('.' for the root).
    name: pkg?.name ?? project?.name ?? (dir === '' ? '.' : dir),
    root: dir,
    manifestPath: pkg ? pkgPath : projectPath,
    dependencies: [...dependencies].sort(),
  };
}

function parseJson<T>(files: Map<string, string>, path: string): T | undefined {
  const text = files.get(path);
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(stripBom(text));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected a JSON object');
    return value as T;
  } catch (error) {
    throw new WorkspaceError(path, `invalid manifest (${(error as Error).message})`);
  }
}

function pnpmPatterns(text: string): string[] {
  let config: unknown;
  try {
    config = parseYaml(text);
  } catch (error) {
    throw new WorkspaceError('pnpm-workspace.yaml', `invalid YAML (${(error as Error).message})`);
  }
  const packages = (config as { packages?: unknown } | null)?.packages;
  if (packages === undefined) return [];
  if (!Array.isArray(packages) || !packages.every((p) => typeof p === 'string')) {
    throw new WorkspaceError('pnpm-workspace.yaml', '`packages` must be a list of glob strings');
  }
  return packages;
}

function npmPatterns(workspaces: NonNullable<PackageJson['workspaces']>): string[] {
  const patterns = Array.isArray(workspaces) ? workspaces : (workspaces.packages ?? []);
  if (!patterns.every((p) => typeof p === 'string')) {
    throw new WorkspaceError('package.json', '`workspaces` must be a list of glob strings');
  }
  return patterns;
}

/** Directory matcher for workspace globs. `!pattern` excludes; `./` prefixes and trailing slashes are normalized. */
export function createMatcher(patterns: readonly string[]): (dir: string) => boolean {
  const normalize = (p: string) => p.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  const include = patterns.filter((p) => !p.startsWith('!')).map(normalize);
  const exclude = patterns.filter((p) => p.startsWith('!')).map((p) => normalize(p.slice(1)));
  if (include.length === 0) return () => false;
  return picomatch(include, { ignore: exclude });
}

/**
 * pnpm accepts several workspace packages with one name (Vite's test fixtures do this), so duplicates are a warning,
 * not an error. The resolver picks the package nearest the importer for an ambiguous name.
 */
function duplicateNameWarnings(packages: readonly WorkspacePackage[]): string[] {
  const byName = new Map<string, string[]>();
  for (const pkg of packages) byName.set(pkg.name, [...(byName.get(pkg.name) ?? []), pkg.manifestPath]);
  return [...byName]
    .filter(([, manifests]) => manifests.length > 1)
    .map(([name, manifests]) => `package name "${name}" is used by ${manifests.length} packages (${manifests.join(', ')}); imports of it resolve to the nearest one`);
}
