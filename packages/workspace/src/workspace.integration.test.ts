/**
 * Integration tests: real git repos (fixtures + synthetic layouts) → GitService → discovery/inventory.
 */
import { languageFromPath, WORKTREE, type Workspace } from '@depwave/core';
import { GitService } from '@depwave/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadFixtures } from '../../../test/support/fixtures.js';
import { TempRepo } from '../../../test/support/tempRepo.js';
import { SourceInventory } from './SourceInventory.js';
import { WorkspaceDiscovery, WorkspaceError } from './WorkspaceDiscovery.js';

const repos: TempRepo[] = [];
afterAll(() => repos.forEach((r) => r.dispose()));

function setup(files: Record<string, string> | ReadonlyMap<string, string>) {
  const { repo, commit } = TempRepo.from(files instanceof Map ? files : new Map(Object.entries(files)));
  repos.push(repo);
  const git = new GitService(repo.dir);
  const discovery = new WorkspaceDiscovery(git);
  return { repo, commit, git, discovery, inventory: new SourceInventory(git, discovery) };
}

const summary = (ws: Workspace) => ws.packages.map((p) => [p.name, p.root, p.dependencies]);
const json = (value: unknown) => JSON.stringify(value, null, 2);

describe('fixture repos', async () => {
  const fixtures = new Map((await loadFixtures()).map((f) => [f.name, f]));

  const expected: Record<string, { tools: string[]; packages: [string, string, string[]][]; owned: Record<string, number> }> = {
    'pnpm-basic': {
      tools: ['pnpm'],
      packages: [
        ['pnpm-basic', '', []],
        ['@basic/app', 'packages/app', ['@basic/ui']],
        ['@basic/ui', 'packages/ui', ['@basic/utils']],
        ['@basic/utils', 'packages/utils', []],
      ],
      owned: { '@basic/app': 4, '@basic/ui': 3, '@basic/utils': 5 },
    },
    'barrel-hell': {
      tools: ['pnpm'],
      packages: [
        ['barrel-hell', '', []],
        ['@barrel/app', 'packages/app', ['@barrel/ui']],
        ['@barrel/ui', 'packages/ui', []],
      ],
      owned: { '@barrel/app': 6, '@barrel/ui': 8 },
    },
    'dynamic-imports': {
      tools: ['pnpm'],
      packages: [
        ['dynamic-imports', '', []],
        ['@dyn/app', 'packages/app', []],
        ['@dyn/plugins', 'packages/plugins', []],
      ],
      owned: { '@dyn/app': 7, '@dyn/plugins': 4 },
    },
    'ts-paths': { tools: [], packages: [['ts-paths', '', []]], owned: { 'ts-paths': 13 } },
    cycles: { tools: [], packages: [['cycles', '', []]], owned: { cycles: 8 } },
  };

  describe.each(Object.keys(expected))('%s', (name) => {
    const fixture = fixtures.get(name);
    if (!fixture) throw new Error(`missing fixture ${name}`);
    const want = expected[name]!;
    const env = setup(fixture.files);

    it('discovers tools, packages, roots and dependencies', async () => {
      const ws = await env.discovery.discover(env.commit);
      expect(ws.tools).toEqual(want.tools);
      expect(summary(ws)).toEqual(want.packages);
    });

    it('inventories every source file with its git oid, language and owner', async () => {
      const { files, workspace } = await env.inventory.inventory(env.commit);
      expect(workspace.packages.map((p) => p.name)).toEqual(want.packages.map(([n]) => n));

      const sourcePaths = [...fixture.files.keys()].filter((p) => languageFromPath(p)).sort();
      expect(files.map((f) => f.path)).toEqual(sourcePaths);

      for (const file of files) {
        expect(file.contentHash, file.path).toBe(env.repo.oid(env.commit, file.path));
        expect(file.language).toBe('typescript');
      }

      const owned: Record<string, number> = {};
      for (const f of files) owned[f.packageName ?? '(none)'] = (owned[f.packageName ?? '(none)'] ?? 0) + 1;
      expect(owned, json(files)).toEqual(want.owned);
    });
  });
});

describe('revision awareness (no filesystem walk)', () => {
  let env: ReturnType<typeof setup>;
  let c1: string;
  let c2: string;

  beforeAll(async () => {
    const fixture = (await loadFixtures()).find((f) => f.name === 'pnpm-basic')!;
    env = setup(new Map([...fixture.files, ['packages/tools/src/gen.ts', 'export {};\n']]));
    c1 = env.commit;
    env.repo.write('packages/tools/package.json', '{ "name": "@basic/tools", "devDependencies": { "@basic/utils": "*" } }\n');
    c2 = env.repo.commit('promote tools to a package');
    env.repo.write('packages/wip/package.json', '{ "name": "@basic/wip" }\n').write('packages/wip/src/w.ts', 'export {};\n');
  });

  it('sees each commit as it was: ownership moves when a directory becomes a package', async () => {
    const at = async (rev: string) => (await env.inventory.inventory(rev)).files.find((f) => f.path === 'packages/tools/src/gen.ts');
    expect((await at(c1))?.packageName).toBe('pnpm-basic'); // falls back to the root package
    expect((await at(c2))?.packageName).toBe('@basic/tools');
  });

  it('includes uncommitted packages and files only in WORKTREE', async () => {
    const names = async (rev: string) => (await env.discovery.discover(rev)).packages.map((p) => p.name);
    expect(await names(c1)).not.toContain('@basic/tools');
    expect(await names(c2)).toContain('@basic/tools');
    expect(await names(c2)).not.toContain('@basic/wip');
    expect(await names(WORKTREE)).toContain('@basic/wip');

    const wip = (await env.inventory.inventory(WORKTREE)).files.find((f) => f.path === 'packages/wip/src/w.ts');
    expect(wip).toMatchObject({ packageName: '@basic/wip', contentHash: env.repo.git('hash-object', 'packages/wip/src/w.ts').trim() });
  });

  it('reads manifests in one batch instead of one git call per package', async () => {
    let batches = 0;
    let single = 0;
    const counting = new Proxy(env.git, {
      get(target, prop, receiver) {
        if (prop === 'readBlobs') batches++;
        if (prop === 'readBlob') single++;
        return Reflect.get(target, prop, receiver);
      },
    });
    await new WorkspaceDiscovery(counting).discover(c2);
    expect(single).toBe(0);
    expect(batches).toBe(2); // root configs, then all manifests
  });
});

describe('workspace flavours', () => {
  it('npm: package.json workspaces with negation; non-matching manifests are ignored', async () => {
    const { discovery, commit } = setup({
      'package.json': json({ name: 'root', workspaces: ['packages/*', '!packages/excluded'] }),
      'package-lock.json': '{}',
      'packages/a/package.json': json({ name: 'a', dependencies: { lodash: '^4' }, peerDependencies: { react: '*' } }),
      'packages/excluded/package.json': json({ name: 'excluded' }),
      'other/c/package.json': json({ name: 'c' }),
    });
    const ws = await discovery.discover(commit);
    expect(ws.tools).toEqual(['npm']);
    expect(summary(ws)).toEqual([
      ['root', '', []],
      ['a', 'packages/a', ['lodash', 'react']],
    ]);
  });

  it('yarn: object-form workspaces, recursive globs and nested package ownership', async () => {
    const { discovery, inventory, commit } = setup({
      'package.json': json({ private: true, workspaces: { packages: ['libs/**'] } }),
      'yarn.lock': '',
      'libs/x/package.json': json({ name: 'x' }),
      'libs/x/src/j.ts': 'export {};\n',
      'libs/x/plugins/y/package.json': json({ name: 'y' }),
      'libs/x/plugins/y/src/i.tsx': 'export {};\n',
    });
    const ws = await discovery.discover(commit);
    expect(ws.tools).toEqual(['yarn']);
    expect(ws.packages.map((p) => p.name)).toEqual(['.', 'x', 'y']); // unnamed root falls back to '.'

    const owners = Object.fromEntries((await inventory.inventory(commit)).files.map((f) => [f.path, [f.packageName, f.language]]));
    expect(owners).toEqual({ 'libs/x/src/j.ts': ['x', 'typescript'], 'libs/x/plugins/y/src/i.tsx': ['y', 'tsx'] });
  });

  it('nx + turbo: project.json projects with and without package.json', async () => {
    const { discovery, commit } = setup({
      'package.json': json({ name: 'nx-root', workspaces: ['packages/*'] }),
      'nx.json': '{}',
      'turbo.json': '{}',
      'packages/p/package.json': json({ name: 'p' }),
      'apps/web/project.json': json({ name: 'web', implicitDependencies: ['p', '!q'] }),
      'libs/shared/project.json': json({ name: 'shared-project' }),
      'libs/shared/package.json': json({ name: '@nx/shared' }),
    });
    const ws = await discovery.discover(commit);
    expect(ws.tools).toEqual(['npm', 'nx', 'turbo']);
    expect(ws.packages.map((p) => [p.name, p.root, p.manifestPath, p.dependencies])).toEqual([
      ['nx-root', '', 'package.json', []],
      ['web', 'apps/web', 'apps/web/project.json', ['p']],
      ['@nx/shared', 'libs/shared', 'libs/shared/package.json', []],
      ['p', 'packages/p', 'packages/p/package.json', []],
    ]);
  });

  it('pnpm without a root package.json: root files have no owner; committed node_modules is ignored', async () => {
    const { discovery, inventory, commit } = setup({
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\nonlyBuiltDependencies:\n  - esbuild\n',
      'scripts/release.ts': 'export {};\n',
      'packages/a/package.json': json({ name: 'a' }),
      'packages/a/index.js': 'export {};\n',
      'packages/a/node_modules/dep/package.json': json({ name: 'dep' }),
      'packages/a/node_modules/dep/index.js': 'module.exports = {};\n',
    });
    expect(summary(await discovery.discover(commit))).toEqual([['a', 'packages/a', []]]);

    const files = (await inventory.inventory(commit)).files;
    expect(files).toEqual([
      expect.objectContaining({ path: 'packages/a/index.js', language: 'javascript', packageName: 'a' }),
      { path: 'scripts/release.ts', language: 'typescript', contentHash: expect.any(String) },
    ]);
  });

  it('turbo alone is detected without defining packages', async () => {
    const { discovery, commit } = setup({ 'package.json': json({ name: 'solo' }), 'turbo.json': '{}' });
    expect(await discovery.discover(commit)).toEqual({
      tools: ['turbo'],
      packages: [{ name: 'solo', root: '', manifestPath: 'package.json', dependencies: [] }],
    });
  });
});

describe('depwave.config.json ignore globs', () => {
  it('hides ignored paths from packages, source files and the path list', async () => {
    const { inventory, commit } = setup({
      'depwave.config.json': json({ ignore: ['fixtures/**', '**/*.generated.ts'] }),
      'pnpm-workspace.yaml': 'packages: ["packages/*", "fixtures/*"]\n',
      'packages/a/package.json': json({ name: 'a' }),
      'packages/a/src/x.ts': 'export {};\n',
      'packages/a/src/api.generated.ts': 'export {};\n',
      'fixtures/demo/package.json': json({ name: 'demo' }),
      'fixtures/demo/src/y.test.ts': 'export {};\n',
    });
    const result = await inventory.inventory(commit);
    expect(result.workspace.packages.map((p) => p.name)).toEqual(['a']);
    expect(result.files.map((f) => f.path)).toEqual(['packages/a/src/x.ts']);
    expect(result.paths).not.toContain('fixtures/demo/src/y.test.ts');
    expect(result.paths).toContain('depwave.config.json');
  });

  it('rejects a malformed config with the file named', async () => {
    const { inventory, commit } = setup({ 'depwave.config.json': json({ ignore: 'fixtures/**' }) });
    await expect(inventory.inventory(commit)).rejects.toThrow('depwave.config.json: `ignore` must be a list of glob strings');
  });
});

describe('errors name the offending file', () => {
  const failure = async (files: Record<string, string>) => {
    const { discovery, commit } = setup(files);
    return discovery.discover(commit).catch((e: unknown) => e);
  };

  it('malformed package.json', async () => {
    const error = await failure({
      'pnpm-workspace.yaml': 'packages: ["packages/*"]\n',
      'packages/bad/package.json': '{ "name": "bad", }',
    });
    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).path).toBe('packages/bad/package.json');
  });

  it('duplicate package names are a warning, not an error (pnpm accepts them; Vite has some)', async () => {
    const { discovery, commit } = setup({
      'pnpm-workspace.yaml': 'packages: ["packages/*"]\n',
      'packages/a/package.json': json({ name: 'same' }),
      'packages/b/package.json': json({ name: 'same' }),
    });
    const ws = await discovery.discover(commit);
    expect(ws.packages.map((p) => p.root)).toEqual(['packages/a', 'packages/b']);
    expect(ws.warnings).toEqual([
      'package name "same" is used by 2 packages (packages/a/package.json, packages/b/package.json); imports of it resolve to the nearest one',
    ]);
  });

  it('a UTF-8 BOM in package.json is fine (Node and pnpm ignore it)', async () => {
    const { discovery, commit } = setup({
      'pnpm-workspace.yaml': 'packages: ["packages/*"]\n',
      'packages/a/package.json': `\uFEFF${json({ name: 'bom' })}`,
    });
    expect((await discovery.discover(commit)).packages.map((p) => p.name)).toEqual(['bom']);
  });

  it('pnpm-workspace.yaml with a non-list `packages`', async () => {
    const error = await failure({ 'pnpm-workspace.yaml': 'packages: "packages/*"\n' });
    expect((error as WorkspaceError).path).toBe('pnpm-workspace.yaml');
  });

  it('a JSON array where a manifest object is expected', async () => {
    const error = await failure({ 'package.json': '[]' });
    expect((error as Error).message).toMatch(/package\.json: invalid manifest \(expected a JSON object\)/);
  });
});
