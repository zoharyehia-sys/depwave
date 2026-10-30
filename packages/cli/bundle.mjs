// Runs before `pack`: turns the workspace build into what the npm package ships. The @depwave/* packages are private,
// so they go inside one file, along with every dependency that has no files of its own to find at run time.
// better-sqlite3 (native) and web-tree-sitter (loads its .wasm next to itself) stay real dependencies.
import { copyFileSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { dependencies } = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));

if (!existsSync(join(here, 'dist/bin.js'))) throw new Error('nothing to bundle: run `pnpm build` first');

const { metafile } = await build({
  absWorkingDir: here,
  entryPoints: ['dist/bin.js'],
  outfile: 'dist/depwave.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: Object.keys(dependencies),
  metafile: true,
  logLevel: 'warning',
  // The CommonJS dependencies call require(); an ES module has none until it makes one.
  banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
});

// Next to dist/, where `../grammars` finds them from the bundle as it does from packages/parser/dist. All gitignored.
cpSync(join(root, 'packages/parser/grammars'), join(here, 'grammars'), { recursive: true });
for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md']) copyFileSync(join(root, file), join(here, file));

// MIT and ISC ask for their notices to travel with the code, and bundling removes the files that carried them.
const packageDirs = new Set();
for (const input of Object.keys(metafile.inputs)) {
  const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (match) packageDirs.add(resolve(here, match[1]));
}
const notices = [...packageDirs].sort().map((dir) => {
  const { name, version, license, author, repository } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const file = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'license'].map((f) => join(dir, f)).find(existsSync);
  // Some packages publish no license file (clipanion, typanion, saxes): name the terms and where the text lives.
  const body = file ? readFileSync(file, 'utf8').trim() : `By ${author?.name ?? author ?? 'its authors'}. See ${repository?.url ?? repository}.`;
  return `${name}@${version} (${license})\n\n${body}\n`;
});
writeFileSync(join(here, 'THIRD-PARTY-LICENSES.txt'), `${notices.join(`\n${'-'.repeat(80)}\n\n`)}`);
