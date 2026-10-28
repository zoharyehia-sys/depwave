#!/usr/bin/env node
// @ts-check
/**
 * Replays every commit in a repository's history that touched its lockfile: `depwave impact <sha>~1..<sha>`, and
 * counts how many test-file runs a selective run would skip versus running every test file on each of those commits.
 * This produced the README's "Results on real repositories" table; `run.mjs` runs it on the pinned repositories.
 *
 * Usage: node scripts/bench/lockfile-replay.mjs <target repo> <lockfile path>
 * Needs a built depwave (`pnpm build`). Prints one line per commit, then `SUMMARY {json}`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BIN = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url));

/**
 * @typedef {{
 *   repo: string; head: string; window: number; lockName: string;
 *   commits: number; noParent: number; failed: number; analyzed: number; narrowed: number; runAll: number;
 *   runs: number; selected: number; skipped: number; pct: number;
 * }} Summary
 */

/**
 * @param {string} repo
 * @param {string} lockName
 * @returns {Summary}
 */
export function replay(repo, lockName) {
  if (!existsSync(BIN)) throw new Error(`${BIN} is missing: run \`pnpm build\` first`);
  const git = (/** @type {string[]} */ ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const commits = git('log', '--format=%h %s', '--', lockName).split('\n').filter(Boolean);

  const s = { commits: commits.length, noParent: 0, failed: 0, analyzed: 0, narrowed: 0, runAll: 0, runs: 0, selected: 0 };
  for (const line of commits) {
    const sha = line.slice(0, line.indexOf(' '));
    if (spawnSync('git', ['-C', repo, 'cat-file', '-e', `${sha}~1^{commit}`]).status !== 0) {
      s.noParent++;
      console.log(`- ${line.slice(0, 70)}  (parent outside the shallow clone)`);
      continue;
    }
    const started = performance.now();
    const args = [BIN, 'impact', '--cwd', repo, '--base', `${sha}~1`, '--head', sha, '--format', 'json'];
    const run = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    const ms = Math.round(performance.now() - started);
    if (run.status !== 0) {
      s.failed++;
      console.log(`✘ ${line.slice(0, 70)} exit=${run.status}\n    ${run.stderr.trim().split('\n')[0]}`);
      continue;
    }
    /** @type {{ report: { globalTriggers: { kind: string; detail?: string }[] }; plan: { runAll: boolean; totalTests: number; groups: { tests: string[] }[] } }} */
    const { report, plan } = JSON.parse(run.stdout);
    const tests = plan.runAll ? plan.totalTests : plan.groups.reduce((n, g) => n + g.tests.length, 0);
    const lock = report.globalTriggers.find((t) => t.kind === 'lockfile');
    s.analyzed++;
    s.runs += plan.totalTests;
    s.selected += tests;
    if (plan.runAll) s.runAll++;
    else s.narrowed++;
    console.log(`${plan.runAll ? '■' : '✔'} ${line.slice(0, 58).padEnd(58)} ${String(ms).padStart(6)}ms  tests=${tests}/${plan.totalTests}  ${lock?.detail ?? ''}`);
  }
  const skipped = s.runs - s.selected;
  const pct = s.runs ? Math.round((skipped / s.runs) * 1000) / 10 : 0;
  return { repo, head: git('rev-parse', 'HEAD'), window: Number(git('rev-list', '--count', 'HEAD')), lockName, ...s, skipped, pct };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [repo, lockName] = process.argv.slice(2);
  if (!repo || !lockName) {
    console.error('Usage: node scripts/bench/lockfile-replay.mjs <target repo> <lockfile path>');
    process.exit(1);
  }
  console.log(`SUMMARY ${JSON.stringify(replay(repo, lockName))}`);
}
