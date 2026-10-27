/**
 * ModuleResolver against real git repositories built from the fixtures, this repository itself,
 * a probe-soundness property, and oxc-resolver as a differential oracle.
 */
import { existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKTREE, type ResolutionResult, type Workspace } from '@depwave/core';
import { GitService } from '@depwave/git';
import { WorkspaceDiscovery } from '@depwave/workspace';
import { ResolverFactory } from 'oxc-resolver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadFixtures, type Fixture } from '../../../test/support/fixtures.js';
import { TempRepo } from '../../../test/support/tempRepo.js';
import { ModuleResolver } from './ModuleResolver.js';
import { dirOf, joinPath } from './paths.js';
import { VirtualFileSystem } from './vfs.js';

const fixtures = await loadFixtures();
const fixture = (name: string): Fixture => fixtures.find((f) => f.name === name)!;
const repos: TempRepo[] = [];
afterAll(() => repos.forEach((r) => r.dispose()));

async function materialize(files: ReadonlyMap<string, string>) {
  const { repo, commit } = TempRepo.from(files);
  repos.push(repo);
  const git = new GitService(repo.dir);
  const workspace = await new WorkspaceDiscovery(git).discover(commit);
  return { repo, commit, git, workspace };
}

const target = (r: ResolutionResult) =>
  r.kind === 'file' ? r.path : r.kind === 'external' ? `external:${r.packageName}` : `unresolved:${r.reason}`;

/** Static and literal dynamic specifiers in a source file (fixtures are simple enough for a regex). */
function specifiersIn(source: string): string[] {
  return [...source.matchAll(/(?:from\s+|import\s*\(\s*|^import\s+)'([^']+)'/gm)].map((m) => m[1]!);
}

function importsOf(f: Fixture): Array<{ from: string; specifier: string }> {
  return [...f.files]
    .filter(([path]) => /\.[jt]sx?$/.test(path))
    .flatMap(([from, source]) => specifiersIn(source).map((specifier) => ({ from, specifier })));
}

describe('ts-paths fixture (acceptance)', () => {
  let env: Awaited<ReturnType<typeof materialize>>;
  let base: ModuleResolver;

  beforeAll(async () => {
    env = await materialize(fixture('ts-paths').files);
    base = await ModuleResolver.load(env.git, env.commit, env.workspace);
  });

  it.each([
    ['src/features/report.ts', '@lib/date', 'src/lib/date.ts'],
    ['src/features/stats.ts', '~/lib/math', 'src/lib/math.ts'],
    ['src/features/legacy.ts', '../utils', 'src/utils.ts'],
    ['src/features/settings.ts', '../config', 'src/config/index.ts'],
    ['src/features/report.test.ts', './report', 'src/features/report.ts'],
    ['src/features/report.test.ts', 'vitest', 'external:vitest'],
  ])('%s: %s → %s', (from, specifier, expected) => {
    expect(target(base.resolve(from, specifier))).toBe(expected);
  });

  it('add-shadowing-file: the new path was probed, and resolution moves to it', async () => {
    const before = base.resolve('src/features/settings.ts', '../config');
    expect(before.probed).toContain('src/config.ts');

    env.repo.write('src/config.ts', "export const config = { source: 'config.ts' };\n");
    const worktree = await ModuleResolver.load(env.git, WORKTREE, env.workspace);
    expect(target(worktree.resolve('src/features/settings.ts', '../config'))).toBe('src/config.ts');
    expect(target(base.resolve('src/features/settings.ts', '../config'))).toBe('src/config/index.ts'); // base commit unaffected
    env.repo.remove('src/config.ts');
  });

  it('delete-shadowing-file: deleting the resolved file re-points the import at the directory index', async () => {
    const before = base.resolve('src/features/legacy.ts', '../utils');
    expect(before.probed).toContain('src/utils.ts');

    env.repo.remove('src/utils.ts');
    const c2 = env.repo.commit('delete utils.ts');
    const after = await ModuleResolver.load(env.git, c2, env.workspace);
    expect(target(after.resolve('src/features/legacy.ts', '../utils'))).toBe('src/utils/index.ts');
    env.repo.git('reset', '-q', '--hard', env.commit);
  });

  it('shadowed-index-change: the shadowed index is not probed, so editing it cannot invalidate', () => {
    expect(base.resolve('src/features/legacy.ts', '../utils').probed).not.toContain('src/utils/index.ts');
  });

  it('tsconfig-change: aliases resolve the same, but configHash changes', async () => {
    const hashBefore = base.configHash('src/features/stats.ts');
    env.repo.write('tsconfig.json', fixture('ts-paths').files.get('tsconfig.json')!.replace('"~/*": ["src/*"]', '"~/*": ["./src/*"]'));
    const after = await ModuleResolver.load(env.git, WORKTREE, env.workspace);
    expect(target(after.resolve('src/features/stats.ts', '~/lib/math'))).toBe('src/lib/math.ts');
    expect(after.configHash('src/features/stats.ts')).not.toBe(hashBefore);
    env.repo.git('checkout', '-q', '--', 'tsconfig.json');
  });
});

describe('workspace packages resolve on a fresh clone (no install)', () => {
  it('pnpm-basic: cross-package imports land on sources, third-party stays external', async () => {
    const env = await materialize(fixture('pnpm-basic').files);
    expect(existsSync(join(env.repo.dir, 'node_modules'))).toBe(false);
    const resolver = await ModuleResolver.load(env.git, env.commit, env.workspace);

    expect(target(resolver.resolve('packages/ui/src/PriceTag.ts', '@basic/utils'))).toBe('packages/utils/src/index.ts');
    expect(target(resolver.resolve('packages/app/src/checkout.ts', '@basic/ui'))).toBe('packages/ui/src/index.ts');
    expect(target(resolver.resolve('packages/app/src/checkout.test.ts', 'vitest'))).toBe('external:vitest');
  });

  it('this repository (working tree): @depwave/core exports dist/ (unbuilt) and maps back to src/ through tsconfig', async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const git = new GitService(root);
    const workspace = await new WorkspaceDiscovery(git).discover(WORKTREE);
    const resolver = await ModuleResolver.load(git, WORKTREE, workspace);

    expect(target(resolver.resolve('packages/git/src/GitService.ts', '@depwave/core'))).toBe('packages/core/src/index.ts');
    expect(target(resolver.resolve('packages/git/src/GitService.ts', './parse.js'))).toBe('packages/git/src/parse.ts');
    expect(target(resolver.resolve('packages/git/src/GitService.ts', 'node:child_process'))).toBe('external:node:child_process');
    expect(target(resolver.resolve('packages/workspace/src/WorkspaceDiscovery.ts', 'picomatch'))).toBe('external:picomatch');
  });
});

describe('probe soundness (every fixture)', () => {
  /**
   * Property: adding a file the resolver did NOT probe can never change its answer.
   * Candidates: every directory near the repo's files × common file names, minus existing and probed paths.
   */
  it.each(fixtures.map((f) => f.name))('%s', async (name) => {
    const f = fixture(name);
    const { workspace } = await materialize(f.files);
    const make = (extra: Record<string, string> = {}) => {
      const contents = new Map([...f.files, ...Object.entries(extra)]);
      return new ModuleResolver(new VirtualFileSystem(contents.keys(), contents), workspace);
    };

    const imports = importsOf(f);
    const baseline = make();
    const results = imports.map(({ from, specifier }) => baseline.resolve(from, specifier));

    const dirs = new Set<string>(['']);
    for (const path of [...f.files.keys(), ...results.flatMap((r) => r.probed)]) {
      for (let d = dirOf(path); !dirs.has(d); d = dirOf(d)) dirs.add(d);
    }
    const names = ['index.ts', 'index.tsx', 'index.js', 'tsconfig.json', 'jsconfig.json', 'package.json', 'other.ts', 'config.ts', 'utils.ts', 'Home.tsx', 'lib.ts', 'src.ts'];
    const candidates = [...dirs].flatMap((d) => names.map((n) => joinPath(d, n))).filter((p) => !f.files.has(p));

    let checked = 0;
    for (const candidate of candidates) {
      const resolver = make({ [candidate]: '{}' });
      imports.forEach(({ from, specifier }, i) => {
        if (results[i]!.probed.includes(candidate)) return;
        checked++;
        const after = resolver.resolve(from, specifier);
        expect(target(after), `adding unprobed ${candidate} changed ${from} → ${specifier}`).toBe(target(results[i]!));
      });
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('differential oracle: oxc-resolver on the same files, checked out and "installed"', () => {
  /** oxc reads the real disk and needs node_modules, so link workspace packages the way pnpm would. */
  function linkWorkspace(dir: string, workspace: Workspace): void {
    for (const pkg of workspace.packages) {
      if (pkg.root === '') continue;
      const link = join(dir, 'node_modules', ...pkg.name.split('/'));
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(join(dir, pkg.root), link, 'junction');
    }
  }

  const oxc = new ResolverFactory({
    tsconfig: 'auto',
    extensions: ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'],
    extensionAlias: { '.js': ['.ts', '.tsx', '.d.ts', '.js'], '.jsx': ['.tsx', '.d.ts', '.jsx'] },
    conditionNames: ['types', 'import', 'require', 'node', 'default'],
    mainFields: ['types', 'module', 'main'],
  });

  it.each(fixtures.map((f) => f.name))('%s: every import resolves exactly as oxc does', async (name) => {
    const f = fixture(name);
    const env = await materialize(f.files);
    linkWorkspace(env.repo.dir, env.workspace);
    const ours = await ModuleResolver.load(env.git, env.commit, env.workspace);

    const toRepoPath = (abs: string) => relative(realpathSync.native(env.repo.dir), realpathSync.native(abs)).split(sep).join('/');
    let compared = 0;
    for (const { from, specifier } of importsOf(f)) {
      const mine = ours.resolve(from, specifier);
      const theirs = oxc.resolveFileSync(join(env.repo.dir, from), specifier);
      const label = `${from} → ${specifier}`;
      if (mine.kind === 'file') {
        expect(theirs.error, label).toBeUndefined();
        expect(toRepoPath(theirs.path!), label).toBe(mine.path);
      } else if (mine.kind === 'external' && !mine.packageName.startsWith('node:')) {
        // Third-party: never a file of the fixture itself. (oxc may still find it in an ancestor node_modules,
        // e.g. when the temp dir sits inside a checkout, as on CI runners.)
        if (theirs.path !== undefined) {
          // Compare real paths: oxc returns realpaths, while temp dirs can be 8.3 short names (Windows) or symlinks (macOS).
          // relative() is absolute when the two sit on different drives (Windows CI: temp on C:, checkout on D:).
          const rel = relative(realpathSync.native(env.repo.dir), realpathSync.native(theirs.path));
          expect(rel.startsWith('..') || isAbsolute(rel), `${label} resolved inside the fixture: ${rel}`).toBe(true);
        }
      } else {
        expect(mine.kind, label).not.toBe('unresolved');
      }
      compared++;
    }
    expect(compared).toBeGreaterThan(5);
  });
});
