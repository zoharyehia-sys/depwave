// What a user gets from npm, tested the way they'd get it: pack, install the tarball into a clean project, and run the
// installed `depwave` on a small monorepo. Each step leans on something only the bundle can get wrong: the bin shim,
// both grammars, SQLite, and the dependencies bundled inside it. Needs `pnpm build` first. Run: pnpm smoke:pack
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_INSTALL_MB = 40;

const cli = fileURLToPath(new URL('../../packages/cli/', import.meta.url));
const { version } = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8'));

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'depwave-packed-')));
const repo = join(tmp, 'project');

const write = (files) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
};
const git = (...args) => execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', ...args], { cwd: repo, stdio: 'ignore' });
const commit = () => {
  git('add', '-A');
  git('commit', '-qm', 'change');
};
/** Through the installed shim, as a user would. A shell, because on Windows `npx` is a .cmd. */
const depwave = (args) => execSync(`npx --no-install depwave ${args}`, { cwd: repo, encoding: 'utf8' });

const sizeOf = (dir) =>
  readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
    const path = join(dir, entry.name);
    return total + (entry.isDirectory() ? sizeOf(path) : statSync(path).size);
  }, 0);

try {
  execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--pack-destination', tmp], { cwd: cli, stdio: 'inherit' });
  const tarball = join(tmp, `depwave-${version}.tgz`);

  mkdirSync(repo);
  write({
    'package.json': '{ "name": "smoke", "private": true }\n',
    '.gitignore': 'node_modules/\n.depwave/\n',
    'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
    'packages/ui/package.json': '{ "name": "@smoke/ui" }\n',
    'packages/ui/src/button.tsx': 'export const Button = () => <b>one</b>;\n',
    'packages/ui/src/button.test.tsx': "import { Button } from './button';\nit('renders', () => Button());\n",
    'packages/ui/src/plain.ts': 'export const plain = 1;\n',
    'packages/ui/src/plain.test.ts': "import { plain } from './plain';\nit('reads', () => plain);\n",
  });
  execSync(`npm install --no-audit --no-fund "${tarball}"`, { cwd: repo, stdio: 'inherit' });

  const modules = join(repo, 'node_modules');
  const installed = join(modules, 'depwave');
  assert.ok(!existsSync(join(modules, 'tree-sitter-typescript')), 'tree-sitter-typescript came back as a dependency');
  assert.ok(!existsSync(join(modules, '@depwave')), 'a private @depwave package leaked into the install');
  for (const file of ['dist/depwave.mjs', 'grammars/tree-sitter-tsx.wasm', 'grammars/tree-sitter-typescript.wasm', 'README.md', 'LICENSE', 'THIRD-PARTY-LICENSES.txt']) {
    assert.ok(existsSync(join(installed, file)), `missing from the package: ${file}`);
  }
  const sizeMb = sizeOf(modules) / 1e6;
  assert.ok(sizeMb < MAX_INSTALL_MB, `install is ${sizeMb.toFixed(1)} MB, over the ${MAX_INSTALL_MB} MB budget`);

  assert.equal(depwave('--version').trim(), version);

  git('init', '-q', '-b', 'main');
  commit();
  write({ 'packages/ui/src/button.tsx': 'export const Button = () => <b>two</b>;\n' });
  commit();

  const { plan, report } = JSON.parse(depwave('impact --base HEAD~1 --format json'));
  assert.deepEqual(plan.groups.flatMap((g) => g.tests), ['packages/ui/src/button.test.tsx']);
  assert.deepEqual(report.unresolved, []);

  // A second run reads what the first wrote to SQLite; the JUnit report goes through the bundled XML parser.
  write({
    'results.xml': `<testsuite name="packages/ui/src/button.test.tsx" failures="1"><testcase name="renders"><failure/></testcase></testsuite>`,
  });
  const { shadow } = JSON.parse(depwave('shadow --base HEAD~1 --results results.xml --format json'));
  assert.equal(shadow.verdict, 'inconclusive'); // one of the two test files has no result: correct, and fully parsed
  assert.deepEqual(shadow.missed, []);
  assert.match(depwave('cache stats'), /\d/);

  console.log(`\npacked install ok: depwave ${version}, ${sizeMb.toFixed(1)} MB installed`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
