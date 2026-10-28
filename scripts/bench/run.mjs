#!/usr/bin/env node
// @ts-check
/**
 * Reproduces the README's "Results on real repositories" table: fetches each repository at its pinned commit, replays
 * its lockfile commits with `lockfile-replay.mjs`, and prints the table rows.
 *
 * Usage: node scripts/bench/run.mjs <work dir> [trpc|vite|jest|playwright ...]
 * Needs a built depwave (`pnpm build`) and network access to github.com. Clones are reused on later runs.
 *
 * depwave reads git objects, never the working tree, so a clone is fetched but never checked out: checking out Vite
 * fails on Windows, whose paths are too long. It keeps its blobs: with `--filter=blob:none`, git fetches each blob
 * depwave reads in a request of its own, thousands of them on a cold run.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { replay } from './lockfile-replay.mjs';

/** The commits the README was measured at. `depth` is how many commits of history each clone holds. */
const PINNED = [
  { name: 'trpc', title: 'tRPC', github: 'trpc/trpc', sha: 'e237729d3ca2f4bb34e6084424e62d12f70380d3', depth: 60, lockfile: 'pnpm-lock.yaml', kind: 'pnpm' },
  { name: 'vite', title: 'Vite', github: 'vitejs/vite', sha: 'cce559ab158cc6b177d0911a0bea73436b48faff', depth: 60, lockfile: 'pnpm-lock.yaml', kind: 'pnpm' },
  { name: 'jest', title: 'Jest', github: 'jestjs/jest', sha: '61050e9323e742539dc2360236671110e37329e6', depth: 120, lockfile: 'yarn.lock', kind: 'Yarn Berry, hoisted' },
  { name: 'playwright', title: 'Playwright', github: 'microsoft/playwright', sha: '1b9b602724484df3ebc41aba77824fdfaba861f6', depth: 120, lockfile: 'package-lock.json', kind: 'npm' },
];

const [work, ...only] = process.argv.slice(2);
const unknown = only.filter((name) => !PINNED.some((p) => p.name === name));
if (!work || unknown.length > 0) {
  console.error(`Usage: node scripts/bench/run.mjs <work dir> [${PINNED.map((p) => p.name).join('|')} ...]`);
  process.exit(1);
}

const git = (/** @type {string} */ dir, /** @type {string[]} */ ...args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

/** Fetches `pin.sha` with `pin.depth` commits of history into `dir` and points HEAD at it, or checks an earlier fetch. */
function fetchPinned(/** @type {typeof PINNED[number]} */ pin, /** @type {string} */ dir) {
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    // Even pack files under a deep work dir can pass Windows' 260-character limit. Other platforms ignore this.
    git(dir, 'config', 'core.longpaths', 'true');
    git(dir, 'remote', 'add', 'origin', `https://github.com/${pin.github}.git`);
    console.log(`fetching ${pin.github} at ${pin.sha.slice(0, 7)} (last ${pin.depth} commits)`);
    git(dir, 'fetch', '-q', '--depth', String(pin.depth), 'origin', pin.sha);
    git(dir, 'update-ref', '--no-deref', 'HEAD', 'FETCH_HEAD');
  }
  const head = git(dir, 'rev-parse', 'HEAD');
  const window = Number(git(dir, 'rev-list', '--count', 'HEAD'));
  if (head !== pin.sha || window !== pin.depth) {
    throw new Error(`${dir} is at ${head} with ${window} commits, not ${pin.sha} with ${pin.depth}: delete it and run again`);
  }
  return dir;
}

const rows = [];
for (const pin of PINNED.filter((p) => only.length === 0 || only.includes(p.name))) {
  console.log(`=== ${pin.title}`);
  const s = replay(fetchPinned(pin, join(work, pin.name)), pin.lockfile);
  console.log(`SUMMARY ${JSON.stringify(s)}`);
  if (s.failed > 0) console.log(`⚠ ${s.failed} commit(s) failed to analyze and are left out`);
  const n = (/** @type {number} */ x) => x.toLocaleString('en-US');
  const skipped = `${n(s.skipped)} (${s.runs ? Math.round((s.skipped / s.runs) * 100) : 0}%)`;
  rows.push(`| [${pin.title}](https://github.com/${pin.github}) | ${pin.kind} | ${s.analyzed} | ${s.narrowed} | ${n(s.runs)} | ${s.skipped ? `**${skipped}**` : skipped} |`);
}
console.log(['', '| Repository | Lockfile | Commits | Narrowed | Test-file runs (baseline) | Skipped |', '|---|---|---|---|---|---|', ...rows].join('\n'));
