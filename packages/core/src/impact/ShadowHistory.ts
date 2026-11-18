import type { ShadowResult } from '../model/shadow.js';

/** One `depwave shadow --format json` output, as CI uploads it. */
export interface ShadowRecord {
  base: string;
  head: string;
  granularity: string;
  shadow: ShadowResult;
}

/** A failing test file a selective run would have skipped, in one run. */
export interface ShadowMiss {
  base: string;
  head: string;
  path: string;
  /** depwave doesn't classify the file as a test, so it could never select it: a test-discovery gap. */
  discovery: boolean;
}

export interface ShadowHistoryOptions {
  /** One-sided confidence of `recallLowerBound`. Default 0.95. */
  confidence?: number;
  /** The recall a selective run should be shown to reach before tests are skipped. Default 0.999. */
  target?: number;
}

/**
 * What many shadow runs add up to. Recall counts only runs that tested the selection: when everything was selected,
 * nothing could be missed, and counting those failures as caught would inflate it.
 */
export interface ShadowHistory {
  /** Records read. CI uploads one per job, so a commit tested on several OSes gives several records but one run. */
  records: number;
  /** Distinct runs (base, head, granularity). */
  runs: number;
  /** Runs where depwave chose a subset. Only these measure the selection. */
  selectionRuns: number;
  /** Runs where a global trigger selected everything. */
  runAllRuns: number;
  /** Selection runs where some test files had no result or some failures named no file. */
  incompleteRuns: number;
  /** Failing test files observed in selection runs, one per file per run. */
  failures: number;
  caught: number;
  missed: ShadowMiss[];
  /** Failures in selection runs that named no test file, so they couldn't be checked. */
  unattributedFailures: number;
  /** caught / failures; undefined until a failure has been observed. */
  recall: number | undefined;
  /** The recall these failures show at `confidence` (exact one-sided Clopper-Pearson bound). */
  recallLowerBound: number | undefined;
  confidence: number;
  target: number;
  /** More failures, all caught, needed before `recallLowerBound` reaches `target`. 0 once it has. */
  failuresNeeded: number;
  /**
   * Mean share of test files a selective run would have skipped. Run-all runs count as 0: they happen too. Runs that
   * don't know their test count (`totalTests` 0) are left out.
   */
  averageSkipped: number | undefined;
}

export function aggregateShadow(records: readonly ShadowRecord[], options: ShadowHistoryOptions = {}): ShadowHistory {
  const confidence = options.confidence ?? 0.95;
  const target = options.target ?? 0.999;

  // The same commit tested on several OSes: one run. The selection is identical, so failures merge as a union.
  const runs = new Map<string, { base: string; head: string; results: ShadowResult[] }>();
  for (const record of records) {
    const key = `${record.base}..${record.head}|${record.granularity}`;
    const run = runs.get(key) ?? { base: record.base, head: record.head, results: [] };
    run.results.push(record.shadow);
    runs.set(key, run);
  }

  let selectionRuns = 0;
  let incompleteRuns = 0;
  let caught = 0;
  let unattributedFailures = 0;
  const missed: ShadowMiss[] = [];
  const skipped: number[] = [];
  for (const { base, head, results } of runs.values()) {
    const first = results[0]!;
    if (!first.basis.selectionTested) {
      skipped.push(0);
      continue;
    }
    selectionRuns++;
    if (results.some((r) => !r.basis.complete)) incompleteRuns++;
    caught += new Set(results.flatMap((r) => r.caught)).size;
    // Each record counts the same untraced failures again; the largest count is the best guess for the run.
    unattributedFailures += Math.max(...results.map((r) => r.unattributedFailures));
    const unrecognized = new Set(results.flatMap((r) => r.unrecognized));
    for (const path of new Set(results.flatMap((r) => r.missed))) missed.push({ base, head, path, discovery: unrecognized.has(path) });
    if (first.totalTests > 0) skipped.push(Math.max(0, 1 - first.selected / first.totalTests));
  }

  const failures = caught + missed.length;
  return {
    records: records.length,
    runs: runs.size,
    selectionRuns,
    runAllRuns: runs.size - selectionRuns,
    incompleteRuns,
    failures,
    caught,
    missed,
    unattributedFailures,
    recall: failures > 0 ? caught / failures : undefined,
    recallLowerBound: failures > 0 ? recallLowerBound(caught, failures, confidence) : undefined,
    confidence,
    target,
    failuresNeeded: failuresNeeded(caught, failures, confidence, target),
    averageSkipped: skipped.length > 0 ? skipped.reduce((a, b) => a + b, 0) / skipped.length : undefined,
  };
}

/**
 * Exact one-sided lower confidence bound for a proportion (Clopper-Pearson): the smallest recall p for which seeing
 * at least `caught` of `failures` still has probability 1 - confidence. With no miss it is (1 - confidence)^(1/n),
 * which is why showing 99.9% at 95% takes about 3,000 failures.
 */
export function recallLowerBound(caught: number, failures: number, confidence: number): number {
  if (caught === 0) return 0;
  const alpha = 1 - confidence;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 100; i++) {
    const p = (low + high) / 2;
    if (atLeast(caught, failures, p) < alpha) low = p;
    else high = p;
  }
  return low;
}

/** P(X >= k) for X ~ Binomial(n, p). Sums the n - k + 1 upper terms: few, since recall is near 1. */
function atLeast(k: number, n: number, p: number): number {
  const logP = Math.log(p);
  const logQ = Math.log1p(-p);
  let logChoose = 0; // log C(n, n)
  let sum = 0;
  for (let i = n; i >= k; i--) {
    sum += Math.exp(logChoose + i * logP + (n - i) * logQ);
    logChoose += Math.log(i) - Math.log(n - i + 1); // log C(n, i - 1)
  }
  return sum;
}

function failuresNeeded(caught: number, failures: number, confidence: number, target: number): number {
  const reached = (more: number) => recallLowerBound(caught + more, failures + more, confidence) >= target;
  if (reached(0)) return 0;
  let high = 1;
  while (!reached(high)) {
    high *= 2;
    if (high > 1e9) return Infinity;
  }
  let low = 0; // not reached
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (reached(mid)) high = mid;
    else low = mid;
  }
  return high;
}
