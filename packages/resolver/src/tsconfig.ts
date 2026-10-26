import { NearestFile } from './nearest.js';
import { dirOf, resolvePath } from './paths.js';
import { isObject, type Lookup, type VirtualFileSystem } from './vfs.js';

/** compilerOptions that can change how a specifier resolves. Only these feed configHash. */
const RESOLUTION_OPTIONS = [
  'baseUrl',
  'paths',
  'rootDir',
  'rootDirs',
  'outDir',
  'moduleResolution',
  'module',
  'customConditions',
  'moduleSuffixes',
  'allowJs',
  'allowImportingTsExtensions',
  'resolvePackageJsonExports',
  'resolvePackageJsonImports',
] as const;

export interface TsConfig {
  /** Config files that contributed, most-derived first (the extends chain). */
  files: string[];
  /** Repo-relative directory, resolved against the config that declared it. */
  baseUrl?: string;
  paths?: Record<string, string[]>;
  /** Directory `paths` substitutions are relative to: baseUrl if set, else the config that declared `paths`. */
  pathsBase?: string;
  outDir?: string;
  rootDir?: string;
  customConditions?: string[];
  /** Raw merged values of RESOLUTION_OPTIONS, for hashing. */
  resolutionOptions: Record<string, unknown>;
}

/**
 * TypeScript's tsconfig semantics for resolution: nearest tsconfig.json/jsconfig.json, `extends` (string or array,
 * relative paths only; package-based extends live in node_modules, which isn't part of the repo), and per-option
 * "relative to the declaring file" rules.
 */
export class TsConfigLoader {
  private readonly nearest: NearestFile;
  private readonly loaded = new Map<string, TsConfig | undefined>();

  constructor(private readonly fs: VirtualFileSystem) {
    this.nearest = new NearestFile(fs, ['tsconfig.json', 'jsconfig.json']);
  }

  /** The config that applies to files in `dir`. Every tsconfig/jsconfig path checked is recorded on `lookup`. */
  forDir(dir: string, lookup: Lookup): TsConfig | undefined {
    const path = this.nearest.find(dir, lookup);
    return path === undefined ? undefined : this.load(path);
  }

  load(path: string, chain: ReadonlySet<string> = new Set()): TsConfig | undefined {
    if (!chain.has(path) && this.loaded.has(path)) return this.loaded.get(path);
    if (chain.has(path)) return undefined; // extends cycle
    const json = this.fs.readJson(path);
    const config = json && this.build(path, json, new Set([...chain, path]));
    this.loaded.set(path, config);
    return config;
  }

  private build(path: string, json: Record<string, unknown>, chain: ReadonlySet<string>): TsConfig {
    const dir = dirOf(path);
    const config: TsConfig = { files: [path], resolutionOptions: {} };

    // Later entries of an `extends` array override earlier ones; the file itself overrides all of them.
    for (const base of this.bases(dir, json['extends'], chain)) {
      config.files.push(...base.files);
      Object.assign(config.resolutionOptions, base.resolutionOptions);
      for (const key of ['baseUrl', 'paths', 'pathsBase', 'outDir', 'rootDir', 'customConditions'] as const) {
        if (base[key] !== undefined) (config as unknown as Record<string, unknown>)[key] = base[key];
      }
    }

    const options = isObject(json['compilerOptions']) ? json['compilerOptions'] : {};
    for (const key of RESOLUTION_OPTIONS) if (options[key] !== undefined) config.resolutionOptions[key] = options[key];

    const dirOption = (key: string): string | undefined => (typeof options[key] === 'string' ? resolvePath(dir, options[key]) : undefined);
    const baseUrl = dirOption('baseUrl');
    if (baseUrl !== undefined) config.baseUrl = baseUrl;
    const outDir = dirOption('outDir');
    if (outDir !== undefined) config.outDir = outDir;
    const rootDir = dirOption('rootDir');
    if (rootDir !== undefined) config.rootDir = rootDir;

    if (isObject(options['paths'])) {
      config.paths = Object.fromEntries(
        Object.entries(options['paths']).map(([key, value]) => [key, Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []]),
      );
      config.pathsBase = dir;
    }
    // baseUrl wins as the paths base wherever it's declared in the chain.
    if (config.paths && config.baseUrl !== undefined) config.pathsBase = config.baseUrl;

    if (Array.isArray(options['customConditions'])) {
      config.customConditions = options['customConditions'].filter((c): c is string => typeof c === 'string');
    }
    return config;
  }

  private bases(dir: string, extendsField: unknown, chain: ReadonlySet<string>): TsConfig[] {
    const entries = typeof extendsField === 'string' ? [extendsField] : Array.isArray(extendsField) ? extendsField : [];
    const bases: TsConfig[] = [];
    for (const entry of entries) {
      if (typeof entry !== 'string' || !(entry.startsWith('./') || entry.startsWith('../'))) continue;
      const target = resolvePath(dir, entry.endsWith('.json') ? entry : `${entry}.json`);
      const base = target === undefined ? undefined : this.load(target, chain);
      if (base) bases.push(base);
    }
    return bases;
  }
}
