#!/usr/bin/env node
// Reproduces the README's "Results on real repositories" table: fetches four open-source monorepos at pinned commits,
// then replays their lockfile commits with lockfile-replay.mjs.
//
//   node scripts/bench/readme-benchmark.mjs [work dir]     (default: <tmp>/depwave-bench)
//
// Clones are shallow and never checked out: depwave reads git objects only, and some of these repositories have paths
// too long to check out on Windows. Needs network access; takes a few minutes.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replay } from './lockfile-replay.mjs';

const REPOS = [
  { name: 'tRPC', repo: 'trpc/trpc', sha: 'e237729d3ca2f4bb34e6084424e62d12f70380d3', depth: 60, lockfile: 'pnpm-lock.yaml' },
  { name: 'Vite', repo: 'vitejs/vite', sha: 'cce559ab158cc6b177d0911a0bea73436b48faff', depth: 60, lockfile: 'pnpm-lock.yaml' },
  { name: 'Jest', repo: 'jestjs/jest', sha: '61050e9323e742539dc2360236671110e37329e6', depth: 120, lockfile: 'yarn.lock' },
  { name: 'Playwright', repo: 'microsoft/playwright', sha: '1b9b602724484df3ebc41aba77824fdfaba861f6', depth: 120, lockfile: 'package-lock.json' },
];

const work = process.argv[2] ?? join(tmpdir(), 'depwave-bench');
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const headOf = (dir) => {
  try {
    return git(dir, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}');
  } catch {
    return undefined; // a fresh repository has no HEAD yet
  }
};

const rows = [];
for (const { name, repo, sha, depth, lockfile } of REPOS) {
  const dir = join(work, repo.replace('/', '__'));
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, 'remote', 'add', 'origin', `https://github.com/${repo}.git`);
  }
  if (headOf(dir) !== sha) {
    console.log(`fetching ${repo} at ${sha.slice(0, 7)} (depth ${depth})…`);
    // Full blobs: with --filter=blob:none, depwave's `git cat-file --batch` would fetch each missing blob in its own
    // round trip, which turns minutes into hours.
    git(dir, '-c', 'core.longpaths=true', 'fetch', '-q', `--depth=${depth}`, 'origin', sha);
    git(dir, 'update-ref', 'HEAD', sha); // no checkout
  }
  console.log(`\n=== ${name} (${lockfile})`);
  rows.push({ name, lockfile, ...replay(dir, lockfile) });
}

const n = (x) => x.toLocaleString('en-US');
console.log('\n| Repository | Lockfile | Commits | Narrowed | Test-file runs (baseline) | Skipped |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) {
  const pct = r.runs ? Math.round((r.skipped / r.runs) * 100) : 0;
  console.log(`| ${r.name} | ${r.lockfile} | ${r.analyzed} | ${r.narrowed} | ${n(r.runs)} | ${n(r.skipped)} (${pct}%) |`);
}
