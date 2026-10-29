/** One test file's result from a real test run (Vitest/Jest JSON, JUnit XML), mapped to a repo-relative path. */
export interface TestFileOutcome {
  path: string;
  status: 'passed' | 'failed' | 'skipped';
}

export interface ShadowRun {
  outcomes: readonly TestFileOutcome[];
  /** Failures the results did not attribute to a file (e.g. JUnit without file paths). They can't be verified. */
  unattributedFailures: number;
}

/**
 * Shadow mode: CI still runs every test, and depwave checks its selection against what actually failed.
 * A failing test depwave did not select is a miss: a selective run would have shipped that regression.
 */
export interface ShadowResult {
  /**
   * An observation about this run, never a proof about the tests a selective run would skip.
   * sound: every test file depwave knows has a result, and every one that failed was selected (or none failed).
   * missed: a failing test file was not selected.
   * inconclusive: nothing was missed, but the check was incomplete: some test files have no result (`partial`), or
   * some failures could not be traced to a file. A failure there would have gone unchecked.
   */
  verdict: 'sound' | 'missed' | 'inconclusive';
  /** A global trigger selected everything, so nothing can be missed, and incomplete results don't matter. */
  runAll: boolean;
  /** Test files depwave selected. */
  selected: number;
  /** Files that appear in the results, test files or not. */
  ran: number;
  /** Some test files depwave knows at head have no result: `notRun` lists them. */
  partial: boolean;
  /** Every test file at head: the denominator for what a selective run would have saved. */
  totalTests: number;
  /** Test files at head with no result, sorted: tests that didn't run, or ran under a runner whose results weren't passed. */
  notRun: string[];
  /** Failing test files, sorted. */
  failed: string[];
  /** Failing test files depwave selected. */
  caught: string[];
  /** Failing test files depwave did NOT select. Each one is a soundness bug (or a flaky test). */
  missed: string[];
  /** Files in the results that depwave does not classify as test files: a test-discovery gap. */
  unrecognized: string[];
  unattributedFailures: number;
}
