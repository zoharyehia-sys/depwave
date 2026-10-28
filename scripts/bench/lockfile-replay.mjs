#!/usr/bin/env node
// Replays every commit in a repository's history that touched a lockfile: `depwave impact <sha>~1..<sha>` per commit,
// counting how many test-file runs a selective run would skip versus running every test file each time.
//
//   node scripts/bench/lockfile-replay.mjs <repo> <lockfile path>
//
// Uses the built CLI (`pnpm build` first). Commits whose parent is outside a shallow clone are skipped.
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url));

/** @returns {{ commits: number, noParent: number, failed: number, analyzed: number, narrowed: number, runAll: number, runs: number, selected: number, skipped: number }} */
export function replay(repo, lockfile, log = console.log) {
  const commits = execFileSync('git', ['-C', repo, 'log', '--format=%h %s', '--', lockfile], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const s = { commits: commits.length, noParent: 0, failed: 0, analyzed: 0, narrowed: 0, runAll: 0, runs: 0, selected: 0, skipped: 0 };
  for (const line of commits) {
    const sha = line.slice(0, line.indexOf(' '));
    const subject = line.slice(sha.length + 1, sha.length + 56).padEnd(55);
    if (spawnSync('git', ['-C', repo, 'cat-file', '-e', `${sha}~1^{commit}`]).status !== 0) {
      s.noParent++;
      log(`- ${sha} ${subject}  (parent outside the shallow clone)`);
      continue;
    }
    const run = spawnSync(process.execPath, [BIN, 'impact', '--cwd', repo, '--base', `${sha}~1`, '--head', sha, '--format', 'json'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    if (run.status !== 0) {
      s.failed++;
      log(`✘ ${sha} ${subject}  exit ${run.status}: ${run.stderr.trim().split('\n')[0]}`);
      continue;
    }
    const { report, plan } = JSON.parse(run.stdout);
    const selected = plan.runAll ? plan.totalTests : plan.groups.reduce((n, g) => n + g.tests.length, 0);
    s.analyzed++;
    s.runs += plan.totalTests;
    s.selected += selected;
    if (plan.runAll) s.runAll++;
    else s.narrowed++;
    // The lockfile's own verdict, then any other global trigger that selected everything.
    const lock = report.globalTriggers.find((t) => t.kind === 'lockfile');
    const others = report.globalTriggers.filter((t) => t.kind !== 'lockfile' && t.scope === undefined).map((t) => t.path);
    log(`${plan.runAll ? '■' : '✔'} ${sha} ${subject}  ${String(selected).padStart(5)}/${plan.totalTests}  ${lock?.detail ?? ''}${others.length ? `  [also: ${others.join(', ')}]` : ''}`);
  }
  s.skipped = s.runs - s.selected;
  return s;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [repo, lockfile] = process.argv.slice(2);
  if (!repo || !lockfile) {
    console.error('usage: node scripts/bench/lockfile-replay.mjs <repo> <lockfile path>');
    process.exit(1);
  }
  const s = replay(repo, lockfile);
  const pct = s.runs ? ((s.skipped / s.runs) * 100).toFixed(1) : '0';
  console.log(`\n${s.analyzed} commits analyzed (${s.narrowed} narrowed, ${s.runAll} ran everything): ${s.skipped} of ${s.runs} test-file runs skipped (${pct}%)`);
}
