# GitHub Action

This repository is a composite action. On a pull request it builds depwave from source, analyzes the diff against
the PR's base branch, writes the report to the job summary, and posts or updates one comment on the PR. On this
repository the whole step takes about 20 seconds, most of it the build.

## Selective test runs

```yaml
# .github/workflows/tests.yml
on: pull_request
permissions:
  contents: read
  pull-requests: write # only for the PR comment; drop it with `comment: 'false'`
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # depwave needs the merge base
      - uses: zoharyehia-sys/depwave@ad89e7cbf88996aa4509391b5bab1b88c9535179 # main on 2026-10-28
        id: depwave
        continue-on-error: true # if the analysis fails, run everything below instead of nothing
      # … set up Node.js and install your dependencies here …
      - name: Run all tests
        if: steps.depwave.outcome != 'success' || steps.depwave.outputs.run-all == 'true'
        run: npx vitest run
      - name: Run impacted tests
        if: steps.depwave.outcome == 'success' && steps.depwave.outputs.run-all != 'true' && steps.depwave.outputs.impacted-tests != '0'
        env:
          TESTS: ${{ steps.depwave.outputs.tests }} # PR-controlled paths: pass them through env, never inline in run:
        run: npx vitest run $TESTS
```

This exact workflow, with this repository's own setup steps filled in, runs on every pull request here:
[`.github/workflows/readme-example.yml`](../.github/workflows/readme-example.yml).

**What happens in each case**

| depwave says | Steps that run |
|---|---|
| Some tests are impacted | *Run impacted tests*, with just those files |
| A global trigger fired (`run-all` is `true`) | *Run all tests* |
| No tests are impacted | Neither: nothing the change can reach has a test |
| The analysis failed (no merge base, broken manifest, …) | *Run all tests*. The depwave step shows as failed, but the job continues |

Without `continue-on-error`, a failed analysis fails the job before any test runs. That's also safe, but it blocks
the pull request until someone fixes the analysis.

For Jest, use `npx jest --runTestsByPath $TESTS`.

**Pinning.** There are no releases yet, so pin the action to a full commit SHA, as above. A branch like `@main` moves,
so the code your CI runs could change without you knowing. Update the SHA deliberately.

**Notes**
- The action sets up Node.js 22 with `actions/setup-node`. If your tests need another version, set it up after the
  depwave step, as in the example.
- On pull requests from forks the token is read-only, so the comment is skipped with a warning. The job summary still
  has the report.
- `fetch-depth: 0` matters: without the merge base, the action fails with
  `depwave: base 'origin/main' not found. Check out with 'fetch-depth: 0' so the merge base is available.`

## Caching

The action keeps depwave's cache (`.depwave/`) between runs with `actions/cache`. Parsed files are keyed by content and
graphs by commit, so a restored cache is never stale: only files and commits depwave hasn't seen are analyzed. On
Jest's repository (2,339 source files), measured locally, the analysis takes about 8 seconds without the cache and 1.6
with it. Set `cache: 'false'` to turn it off.

A pull request's first run can only restore a cache from the PR itself or from its base branch. To make first runs
warm too, run the action on pushes to the base branch:

```yaml
# .github/workflows/depwave-cache.yml
on:
  push:
    branches: [main]
jobs:
  cache:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: zoharyehia-sys/depwave@ad89e7cbf88996aa4509391b5bab1b88c9535179
        with:
          comment: 'false'
```

Each cache entry holds the parsed files plus at most 64 MB of commit graphs. GitHub evicts entries that go unused for
a week.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `base` | `origin/<PR base branch>` | Revision to compare against (its merge base is used) |
| `granularity` | `symbol` | `symbol` or `file` |
| `explain` | `3` | `depwave why` paths for the top N tests in the comment (`0` for none) |
| `comment` | `true` | Post or update the sticky PR comment |
| `test-results` | | Shadow mode: results of a full test run (paths separated by spaces or newlines) |
| `cache` | `true` | Keep depwave's cache between runs (see [Caching](#caching)) |
| `github-token` | `github.token` | Token for the comment. Needs `pull-requests: write` |

## Outputs

| Output | Meaning |
|---|---|
| `impacted-tests` | Number of impacted test files |
| `total-tests` | Number of test files at head |
| `run-all` | `true` when a global trigger selected every test |
| `tests` | Impacted test files, separated by spaces |
| `report` | Path to the full JSON report |
| `shadow-verdict` | With `test-results`: `sound`, `missed` or `inconclusive` |
| `shadow-missed` | With `test-results`: failing test files depwave didn't select |

Outputs are empty when the analysis failed. Check `steps.<id>.outcome` first, as the example does.

## Shadow mode

Before you skip anything, run the action **after** a full test run and pass it the results. The verdict is added to
the PR comment, and when a failing test was missed the job fails, after the comment is posted.

```yaml
      - name: Run all tests
        run: npx vitest run --reporter=default --reporter=json --outputFile.json=test-results.json
      - uses: zoharyehia-sys/depwave@ad89e7cbf88996aa4509391b5bab1b88c9535179
        if: ${{ !cancelled() }} # failing runs are the interesting ones
        with:
          test-results: test-results.json
```

What the verdicts mean, and what they don't prove: [shadow mode](../README.md#shadow-mode).

## Other CI systems

There is no packaged integration yet. Build depwave as in the [quick start](../README.md#quick-start) and call the
CLI: `--format json` for scripts, and `--format markdown` for a PR comment. See the [CLI reference](cli.md).
