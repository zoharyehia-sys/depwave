# CLI reference

Every command, option and exit code of the `depwave` CLI, plus configuration and the cache. For a first run, see the
[quick start](../README.md#quick-start).

## Commands

| Command | What it does |
|---|---|
| `depwave impact` | Lists the test files a diff impacts, grouped by package |
| `depwave why <file>` | Shows the shortest dependency chain from a change to `<file>`, or says it isn't impacted |
| `depwave shadow --results <file>` | Checks a full test run's failures against what depwave would have selected ([shadow mode](../README.md#shadow-mode)) |
| `depwave cycles` | Lists import cycles: groups of files that import each other, each shown as its shortest loop |
| `depwave graph` | Draws workspace packages, or the files of one package, as a Mermaid or Graphviz diagram |
| `depwave cache stats` | Shows what the cache holds, and its size |
| `depwave cache clear` | Empties the cache |

`depwave <command> --help` prints the same options with examples.

## Options

| Option | Default | Applies to | Meaning |
|---|---|---|---|
| `--base <rev>` | `origin/main` | `impact`, `why`, `shadow` | Revision to compare against. The merge base with `--head` is used, so commits that landed on the base branch after you branched don't count |
| `--head <rev>` | `HEAD` | `impact`, `why`, `shadow` | Revision to analyze. `WORKTREE` adds uncommitted and untracked changes |
| `--format <f>` | `text` | `impact`, `why`, `shadow` | `text` or `json`. `impact` and `shadow` also accept `markdown`, which is used for PR comments |
| `--granularity <g>` | `symbol` | `impact`, `why`, `shadow` | `symbol` follows functions, classes and variables. `file` follows whole files and never selects fewer tests |
| `--explain <n>` | `3` | `impact` | With `--format markdown`, includes `depwave why` paths for the top `n` tests (`0` for none) |
| `--results <file>` | required | `shadow` | Vitest/Jest JSON or JUnit XML, detected from the content. Repeatable |
| `--results-root <dir>` | repository root | `shadow` | Directory that relative paths in the results are resolved from |
| `--rev <rev>` | `HEAD` | `cycles`, `graph` | Revision to inspect. `WORKTREE` includes uncommitted and untracked changes |
| `--include-type-only` | off | `cycles` | Count `import type` edges too. They're erased at runtime, so they can't cause load-order bugs |
| `--level <l>` | `package` | `graph` | `package`: declared workspace dependencies. `file`: imports between files |
| `--package <name>` | all | `graph` | With `--level file`, only this package's files. Imports that leave it point at the target package |
| `--cwd <dir>` | current directory | all | Repository to analyze |
| `--no-cache` | cache on | all but `cache` | Skips the `.depwave/` cache |

`depwave why` accepts a path relative to the current directory, an absolute path, or a repo-relative path.

`cycles` follows runtime imports and re-exports. Dynamic `import()` is skipped, because it loads only when called.
`graph --format` takes `mermaid` (the default), `dot` (render it with `dot -Tsvg`) or `json`. At the file level, dynamic
imports are drawn dashed, type-only imports dotted, test files filled, and files in an import cycle outlined in red.

```bash
depwave cycles --rev WORKTREE                       # lint uncommitted work for cycles
depwave graph --level file --package @acme/ui --format dot | dot -Tsvg > ui.svg
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. This includes `why` reporting that a file isn't impacted, and a `sound` or `inconclusive` shadow verdict |
| `1` | Failure, with a one-line message on stderr: not a git repository, an unknown revision, an invalid manifest or config, an invalid option, a path `why` doesn't know, or a results file without tests |
| `3` | `shadow`: a failing test file was not selected |
| `4` | `cycles`: at least one import cycle exists, so CI can use it as a lint |

## JSON output

`depwave impact --format json` prints `{ "report": …, "plan": … }`:

- `plan`: `runAll` (a global trigger selected every test), `totalTests`, and `groups` of
  `{ packageName, runner, tests }`, where `runner` is `vitest`, `jest` or `unknown`, taken from the package's
  dependencies or the root's.
- `report`: `base`, `head`, `granularity`, `changedFiles`, `seeds`, `globalTriggers`, every `impacted` node with its
  distance and score, and `unresolved` imports.

`depwave why --format json` and `depwave shadow --format json` print the explanation and the shadow result, plus the
revisions compared. `depwave cycles --format json` prints each cycle's sorted `files` and one `loop`, plus unresolved
imports (a cycle through one can't be seen). `depwave graph --format json` prints `nodes` and `edges`. The JSON shapes
aren't stable yet.

## Configuration

`depwave.config.json` is optional, and lives at the repository root. It's read from git at each analyzed revision, so
the base and the head of a diff can each have their own.

```json
{ "ignore": ["fixtures/**", "**/*.generated.ts"] }
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `ignore` | `string[]` (repo-relative globs) | `[]` | Paths that aren't part of the code under analysis: fixtures, examples, vendored or generated code. Ignored paths define no packages, add no files to the graph, and never match dynamic-import globs |

Unknown keys are ignored, and a malformed file fails the run with `depwave: depwave.config.json: …`. Changing this
file selects every test, since it changes what's analyzed.

## Cache

`depwave` keeps a cache at `.depwave/cache.db` in the repository root (SQLite, WAL mode). The directory contains a
`.gitignore` of `*`, so it never shows up in `git status` or in a `WORKTREE` analysis.

| Layer | Key | Holds |
|---|---|---|
| Facts | Content hash, language, parser version | The facts parsed from one file's content: unchanged files are never re-parsed |
| Snapshots | Commit SHA, analysis version | The whole graph of a commit: a warm merge base skips git listing, parsing and resolution |

Both keys are immutable inputs, so entries can't go stale. Upgrading depwave changes the analysis version, so old
entries are no longer used. Uncommitted work (`WORKTREE`) is never snapshotted, but still reuses parsed facts per file.

The cache never changes an answer. If it fails (a corrupt file, a full disk, a missing native binary), the run
continues uncached with a warning. A third layer, for module resolutions, is implemented but not used: resolving over
an in-memory view of the revision is faster than a cache lookup. [ARCHITECTURE.md
§4.1](../ARCHITECTURE.md#41-three-cache-layers-three-different-invalidation-rules) explains why.
