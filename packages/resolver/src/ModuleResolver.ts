import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import {
  toPosixPath,
  type GitPort,
  type ResolutionResult,
  type ResolverPort,
  type Revision,
  type TrackedFile,
  type UnresolvedReason,
  type Workspace,
  type WorkspacePackage,
} from '@ripple/core';
import { NearestFile } from './nearest.js';
import { exportsTargets, importsTargets } from './packageMaps.js';
import { dirOf, isRelativeSpecifier, joinPath, packageNameOf, resolvePath } from './paths.js';
import { TsConfigLoader, type TsConfig } from './tsconfig.js';
import { Lookup, VirtualFileSystem } from './vfs.js';

/** Bump when resolution behaviour changes: it's part of every configHash, so cached resolutions invalidate. */
export const RESOLVER_VERSION = 1;

export interface ModuleResolverOptions {
  /** package.json conditions, in addition to tsconfig `customConditions`. `default` always matches. */
  conditions?: readonly string[];
  /** Extension probe order for extensionless specifiers. */
  extensions?: readonly string[];
}

const DEFAULT_CONDITIONS = ['types', 'import', 'require', 'node', 'default'];
/** TypeScript "bundler" order: TS sources first, then declarations, then JS. */
const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
/** `./x.js` in TS ESM source refers to `x.ts`: TS tries these before the literal file. */
const TS_EXTENSION_ALIASES: Record<string, readonly string[]> = {
  '.js': ['.ts', '.tsx', '.d.ts'],
  '.jsx': ['.tsx', '.d.ts'],
  '.mjs': ['.mts', '.d.mts'],
  '.cjs': ['.cts', '.d.cts'],
};
const MAIN_FIELDS = ['types', 'module', 'main'] as const;
/** Common build-output directories, mapped back to `src/` when a package has no tsconfig outDir. */
const OUTPUT_DIRS = ['dist', 'build', 'out', 'lib', 'esm', 'cjs'];
const BUILTINS = new Set(builtinModules);

type Outcome =
  | { kind: 'file'; path: string }
  | { kind: 'external'; packageName: string; specifier: string }
  | { kind: 'unresolved'; reason: UnresolvedReason };

const unresolved = (reason: UnresolvedReason): Outcome => ({ kind: 'unresolved', reason });
const file = (path: string): Outcome => ({ kind: 'file', path });

/**
 * Resolves import specifiers against one revision of the repository, recording every path it checks.
 *
 * Order, for non-relative specifiers (mirrors TypeScript, then Node):
 *   builtin → tsconfig `paths` → tsconfig `baseUrl` → `#imports` → workspace package → external.
 * Workspace packages resolve through their manifests (exports → main fields → index), never node_modules,
 * so analysis works on a fresh clone. Missing build outputs map back to sources (dist/x.js → src/x.ts).
 */
export class ModuleResolver implements ResolverPort {
  private readonly tsconfigs: TsConfigLoader;
  private readonly packageJsons: NearestFile;
  /** Longest name first, so `@acme/ui-kit` is never mistaken for `@acme/ui`. */
  private readonly packages: WorkspacePackage[];
  private readonly conditions: readonly string[];
  private readonly extensions: readonly string[];
  private readonly hashByDir = new Map<string, string>();
  private workspaceDigest: string | undefined;

  constructor(
    private readonly fs: VirtualFileSystem,
    private readonly workspace: Workspace,
    options: ModuleResolverOptions = {},
  ) {
    this.tsconfigs = new TsConfigLoader(fs);
    this.packageJsons = new NearestFile(fs, ['package.json']);
    this.packages = [...workspace.packages].sort((a, b) => b.name.length - a.name.length);
    this.conditions = options.conditions ?? DEFAULT_CONDITIONS;
    this.extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  }

  /** Builds the virtual file system for `rev` (one listing + one batched config read). */
  static async load(git: GitPort, rev: Revision, workspace: Workspace, tracked?: readonly TrackedFile[], options?: ModuleResolverOptions): Promise<ModuleResolver> {
    return new ModuleResolver(await VirtualFileSystem.fromGit(git, rev, tracked), workspace, options);
  }

  resolve(fromFile: string, specifier: string): ResolutionResult {
    const lookup = new Lookup(this.fs);
    const outcome = this.resolveSpecifier(lookup, toPosixPath(fromFile), specifier);
    return { ...outcome, probed: lookup.probed };
  }

  configHash(fromFile: string): string {
    const dir = dirOf(toPosixPath(fromFile));
    let hash = this.hashByDir.get(dir);
    if (hash === undefined) {
      const scratch = new Lookup(this.fs); // probes are irrelevant here: only content feeds the hash
      const tsconfig = this.tsconfigs.forDir(dir, scratch);
      const packageJson = this.packageJsons.find(dir, scratch);
      const manifest = packageJson === undefined ? undefined : this.fs.readJson(packageJson);
      hash = digest({
        version: RESOLVER_VERSION,
        conditions: this.conditions,
        extensions: this.extensions,
        tsconfig: tsconfig && describeTsConfig(tsconfig),
        packageJson: packageJson && { path: packageJson, name: manifest?.['name'], type: manifest?.['type'], imports: manifest?.['imports'] },
        workspace: this.workspaceHash(),
      });
      this.hashByDir.set(dir, hash);
    }
    return hash;
  }

  // ─── strategies ──────────────────────────────────────────────────────────────

  private resolveSpecifier(lookup: Lookup, from: string, specifier: string): Outcome {
    if (specifier === '' || specifier.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(specifier) && !specifier.startsWith('node:')) {
      return unresolved('unsupported-syntax'); // absolute paths and URLs (data:, http:, file:)
    }
    if (specifier.startsWith('node:') || BUILTINS.has(specifier)) {
      return { kind: 'external', packageName: specifier.startsWith('node:') ? specifier : `node:${specifier}`, specifier };
    }
    if (isRelativeSpecifier(specifier)) {
      const found = this.fileOrDirectory(lookup, resolvePath(dirOf(from), specifier));
      return found === undefined ? unresolved('not-found') : file(found);
    }

    const tsconfig = this.tsconfigs.forDir(dirOf(from), lookup);
    const conditions = [...(tsconfig?.customConditions ?? []), ...this.conditions];

    const viaPaths = tsconfig && this.tsconfigPaths(lookup, tsconfig, specifier);
    if (viaPaths !== undefined) return file(viaPaths);
    if (tsconfig?.baseUrl !== undefined) {
      const viaBaseUrl = this.fileOrDirectory(lookup, resolvePath(tsconfig.baseUrl, specifier));
      if (viaBaseUrl !== undefined) return file(viaBaseUrl);
    }
    if (specifier.startsWith('#')) return this.packageImports(lookup, from, specifier, conditions);
    return this.workspacePackage(lookup, specifier, conditions) ?? { kind: 'external', packageName: packageNameOf(specifier), specifier };
  }

  /** tsconfig `paths`: an exact key wins, else the pattern with the longest prefix; substitutions tried in order. */
  private tsconfigPaths(lookup: Lookup, config: TsConfig, specifier: string): string | undefined {
    if (!config.paths || config.pathsBase === undefined) return undefined;
    let best: { key: string; capture: string; prefixLength: number } | undefined;
    for (const key of Object.keys(config.paths)) {
      const star = key.indexOf('*');
      if (star === -1) {
        if (key === specifier) {
          best = { key, capture: '', prefixLength: Infinity };
          break;
        }
        continue;
      }
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (specifier.length < prefix.length + suffix.length || !specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      if (!best || prefix.length > best.prefixLength) {
        best = { key, capture: specifier.slice(prefix.length, specifier.length - suffix.length), prefixLength: prefix.length };
      }
    }
    if (!best) return undefined;
    for (const substitution of config.paths[best.key] ?? []) {
      const found = this.fileOrDirectory(lookup, resolvePath(config.pathsBase, substitution.replace('*', best.capture)));
      if (found !== undefined) return found;
    }
    return undefined; // like TS: an unmatched alias falls through to normal module resolution
  }

  /** `#internal` specifiers via the nearest package.json `imports` field. */
  private packageImports(lookup: Lookup, from: string, specifier: string, conditions: readonly string[]): Outcome {
    const manifestPath = this.packageJsons.find(dirOf(from), lookup);
    const manifest = manifestPath === undefined ? undefined : this.fs.readJson(manifestPath);
    const targets = manifest && importsTargets(manifest['imports'], specifier, conditions);
    if (!targets || manifestPath === undefined) return unresolved('not-found');

    for (const target of targets) {
      if (target.startsWith('./')) {
        const found = this.fileOrDirectory(lookup, resolvePath(dirOf(manifestPath), target));
        if (found !== undefined) return file(found);
      } else if (!target.startsWith('#')) {
        return this.resolveSpecifier(lookup, from, target); // "#dep": "some-package"
      }
    }
    return unresolved('not-found');
  }

  private workspacePackage(lookup: Lookup, specifier: string, conditions: readonly string[]): Outcome | undefined {
    const pkg = this.packages.find((p) => specifier === p.name || specifier.startsWith(`${p.name}/`));
    if (!pkg) return undefined;
    const subpath = specifier === pkg.name ? '.' : `.${specifier.slice(pkg.name.length)}`;
    const manifest = pkg.manifestPath.endsWith('package.json') ? this.fs.readJson(pkg.manifestPath) : undefined;

    if (manifest?.['exports'] !== undefined) {
      const targets = exportsTargets(manifest['exports'], subpath, conditions);
      const found = targets && this.packageTargets(lookup, pkg, targets);
      return found === undefined ? unresolved('not-found') : file(found);
    }

    let found: string | undefined;
    if (subpath === '.') {
      const mainTargets = MAIN_FIELDS.map((field) => manifest?.[field]).filter((v): v is string => typeof v === 'string');
      found = this.packageTargets(lookup, pkg, mainTargets) ?? this.index(lookup, pkg.root);
    } else {
      found = this.fileOrDirectory(lookup, resolvePath(pkg.root, subpath));
    }
    return found === undefined ? unresolved('not-found') : file(found);
  }

  /** Package targets in priority order: any that exists as-is wins; otherwise map build outputs back to sources. */
  private packageTargets(lookup: Lookup, pkg: WorkspacePackage, targets: readonly string[]): string | undefined {
    const paths = targets
      .filter((t) => !t.startsWith('../') && !t.startsWith('/'))
      .map((t) => resolvePath(pkg.root, t))
      .filter((p): p is string => p !== undefined);
    for (const path of paths) {
      const found = this.file(lookup, path);
      if (found !== undefined) return found;
    }
    for (const path of paths) {
      for (const source of this.sourceCandidates(lookup, pkg, path)) {
        const found = this.fileOrDirectory(lookup, source);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }

  /** dist/x.js → src/x (extension probing follows). tsconfig outDir/rootDir first, then conventional names. */
  private sourceCandidates(lookup: Lookup, pkg: WorkspacePackage, target: string): string[] {
    const config = this.tsconfigs.forDir(pkg.root, lookup);
    const mappings: Array<[outDir: string, sourceDir: string]> = [];
    if (config?.outDir !== undefined) mappings.push([config.outDir, config.rootDir ?? joinPath(pkg.root, 'src')]);
    for (const out of OUTPUT_DIRS) mappings.push([joinPath(pkg.root, out), joinPath(pkg.root, 'src')]);

    const candidates: string[] = [];
    for (const [outDir, sourceDir] of mappings) {
      if (!target.startsWith(`${outDir}/`)) continue;
      const rest = target.slice(outDir.length + 1).replace(/(\.d)?\.[mc]?[jt]sx?$/, '');
      const candidate = joinPath(sourceDir, rest);
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
    return candidates;
  }

  // ─── file system probing ─────────────────────────────────────────────────────

  private fileOrDirectory(lookup: Lookup, path: string | undefined): string | undefined {
    if (path === undefined) return undefined;
    return this.file(lookup, path) ?? this.directory(lookup, path);
  }

  /** `x.js` → x.ts/x.tsx/x.d.ts first (TS ESM), then the literal path, then `x` + each extension. */
  private file(lookup: Lookup, path: string): string | undefined {
    if (path === '') return undefined;
    const ext = /\.[^./]+$/.exec(path)?.[0];
    for (const alias of (ext && TS_EXTENSION_ALIASES[ext]) ?? []) {
      const candidate = path.slice(0, -ext!.length) + alias;
      if (lookup.isFile(candidate)) return candidate;
    }
    if (lookup.isFile(path)) return path;
    for (const extension of this.extensions) {
      if (lookup.isFile(path + extension)) return path + extension;
    }
    return undefined;
  }

  /** A directory import: its own package.json main fields, then index.* */
  private directory(lookup: Lookup, dir: string): string | undefined {
    const manifestPath = joinPath(dir, 'package.json');
    if (lookup.isFile(manifestPath)) {
      const manifest = this.fs.readJson(manifestPath);
      for (const field of MAIN_FIELDS) {
        const value = manifest?.[field];
        if (typeof value !== 'string') continue;
        const target = resolvePath(dir, value);
        const found = target === undefined ? undefined : (this.file(lookup, target) ?? this.index(lookup, target));
        if (found !== undefined) return found;
      }
    }
    return this.index(lookup, dir);
  }

  private index(lookup: Lookup, dir: string): string | undefined {
    for (const extension of this.extensions) {
      const candidate = joinPath(dir, `index${extension}`);
      if (lookup.isFile(candidate)) return candidate;
    }
    return undefined;
  }

  // ─── hashing ─────────────────────────────────────────────────────────────────

  /** Everything about workspace packages that resolution reads: names, roots, manifest entry points, source mapping. */
  private workspaceHash(): string {
    this.workspaceDigest ??= digest(
      [...this.workspace.packages]
        .sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0))
        .map((pkg) => {
          const manifest = pkg.manifestPath.endsWith('package.json') ? this.fs.readJson(pkg.manifestPath) : undefined;
          const tsconfig = this.tsconfigs.forDir(pkg.root, new Lookup(this.fs));
          return {
            name: pkg.name,
            root: pkg.root,
            manifest: pkg.manifestPath,
            entry: Object.fromEntries(['exports', 'imports', ...MAIN_FIELDS].map((f) => [f, manifest?.[f]])),
            outDir: tsconfig?.outDir,
            rootDir: tsconfig?.rootDir,
          };
        }),
    );
    return this.workspaceDigest;
  }
}

function describeTsConfig(config: TsConfig): unknown {
  return {
    files: config.files,
    baseUrl: config.baseUrl,
    paths: config.paths,
    pathsBase: config.pathsBase,
    outDir: config.outDir,
    rootDir: config.rootDir,
    options: config.resolutionOptions,
  };
}

/** Deterministic for equal inputs: JSON key order follows the config files' own order, which is meaningful (exports). */
function digest(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value) ?? 'undefined').digest('hex').slice(0, 16);
}
