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
   * sound: every failing test was selected. missed: at least one was not.
   * inconclusive: nothing was missed, but some failures could not be traced to a file.
   */
  verdict: 'sound' | 'missed' | 'inconclusive';
  /** A global trigger selected everything, so nothing can be missed. */
  runAll: boolean;
  /** Test files depwave selected. */
  selected: number;
  /** Test files that appear in the results (the full run). */
  ran: number;
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
