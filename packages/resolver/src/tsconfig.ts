import { NearestFile } from './nearest.js';
import { dirOf, joinPath, resolvePath } from './paths.js';
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
/** Resolves a non-relative `extends` (`"@acme/tsconfig/base.json"`) to a repository path, or undefined. */
export type ExtendsResolver = (specifier: string) => string | undefined;

const CONFIG_DIR = '${configDir}';

export class TsConfigLoader {
  private readonly nearest: NearestFile;
  private readonly loaded = new Map<string, TsConfig | undefined>();

  constructor(
    private readonly fs: VirtualFileSystem,
    private readonly resolveExtends: ExtendsResolver = () => undefined,
  ) {
    this.nearest = new NearestFile(fs, ['tsconfig.json', 'jsconfig.json']);
  }

  /** The config that applies to files in `dir`. Every tsconfig/jsconfig path checked is recorded on `lookup`. */
  forDir(dir: string, lookup: Lookup): TsConfig | undefined {
    const path = this.nearest.find(dir, lookup);
    return path === undefined ? undefined : this.load(path);
  }

  /**
   * `leafDir` is the directory of the config being resolved for. TypeScript 5.5's `${configDir}` in a shared base
   * config means THAT directory, so the same base resolves differently per extending config (and is cached per leaf).
   */
  load(path: string, chain: ReadonlySet<string> = new Set(), leafDir: string = dirOf(path)): TsConfig | undefined {
    const key = `${path}\u0000${leafDir}`;
    if (!chain.has(path) && this.loaded.has(key)) return this.loaded.get(key);
    if (chain.has(path)) return undefined; // extends cycle
    const json = this.fs.readJson(path);
    const config = json && this.build(path, json, new Set([...chain, path]), leafDir);
    this.loaded.set(key, config);
    return config;
  }

  private build(path: string, json: Record<string, unknown>, chain: ReadonlySet<string>, leafDir: string): TsConfig {
    const dir = dirOf(path);
    const config: TsConfig = { files: [path], resolutionOptions: {} };

    // Later entries of an `extends` array override earlier ones; the file itself overrides all of them.
    for (const base of this.bases(dir, json['extends'], chain, leafDir)) {
      config.files.push(...base.files);
      Object.assign(config.resolutionOptions, base.resolutionOptions);
      for (const key of ['baseUrl', 'paths', 'pathsBase', 'outDir', 'rootDir', 'customConditions'] as const) {
        if (base[key] !== undefined) (config as unknown as Record<string, unknown>)[key] = base[key];
      }
    }

    const options = isObject(json['compilerOptions']) ? json['compilerOptions'] : {};
    for (const key of RESOLUTION_OPTIONS) if (options[key] !== undefined) config.resolutionOptions[key] = options[key];

    /** A path option, relative to the declaring config, or to the leaf config through `${configDir}`. */
    const resolveOption = (value: string): string | undefined =>
      value.includes(CONFIG_DIR) ? resolvePath('', value.replaceAll(CONFIG_DIR, leafDir || '.')) : resolvePath(dir, value);
    const dirOption = (key: string): string | undefined => (typeof options[key] === 'string' ? resolveOption(options[key]) : undefined);
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
      // `${configDir}` substitutions are absolute: rewrite them relative to whatever base the paths end up using.
      if (Object.values(config.paths).some((subs) => subs.some((s) => s.includes(CONFIG_DIR)))) config.pathsBase = '';
      config.paths = Object.fromEntries(
        Object.entries(config.paths).map(([key, subs]) => [key, subs.map((s) => (s.includes(CONFIG_DIR) ? s.replaceAll(CONFIG_DIR, leafDir || '.') : config.pathsBase === '' ? joinPath(dir, s) : s))]),
      );
    }
    // baseUrl wins as the paths base wherever it's declared in the chain.
    if (config.paths && config.baseUrl !== undefined) config.pathsBase = config.baseUrl;

    if (Array.isArray(options['customConditions'])) {
      config.customConditions = options['customConditions'].filter((c): c is string => typeof c === 'string');
    }
    return config;
  }

  /**
   * Relative `extends` resolve against the declaring config. Package `extends` (`"@acme/tsconfig/base.json"`) resolve
   * through the workspace when the package lives in the repo; ones in node_modules can't be seen and are skipped.
   */
  private bases(dir: string, extendsField: unknown, chain: ReadonlySet<string>, leafDir: string): TsConfig[] {
    const entries = typeof extendsField === 'string' ? [extendsField] : Array.isArray(extendsField) ? extendsField : [];
    const bases: TsConfig[] = [];
    for (const entry of entries) {
      if (typeof entry !== 'string') continue;
      const target =
        entry.startsWith('./') || entry.startsWith('../')
          ? resolvePath(dir, entry.endsWith('.json') ? entry : `${entry}.json`)
          : this.resolveExtends(entry);
      const base = target === undefined ? undefined : this.load(target, chain, leafDir);
      if (base) bases.push(base);
    }
    return bases;
  }
}
