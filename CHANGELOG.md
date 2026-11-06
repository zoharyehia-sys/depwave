# Changelog

depwave follows [Semantic Versioning](https://semver.org). Until 1.0, a minor version can change selection rules, the
CLI and the JSON output.

## 0.1.0-alpha.0 (unreleased)

The first npm release. It's an alpha: run it in
[shadow mode](https://github.com/zoharyehia-sys/depwave#shadow-mode) next to your full test suite, and don't skip tests
based on it yet.

```bash
npm install --global depwave@alpha
```

Requires Node.js 22 or later and git. The install has no build step: depwave is one bundled file, SQLite comes
prebuilt for Linux, macOS and Windows, and the parser is WebAssembly.

- **Test selection:** `depwave impact` selects the test files a diff can reach, through a symbol-level graph of both
  revisions, across barrel files and workspace packages. `--granularity file` follows whole files instead.
- **Explanations:** `depwave why` shows the chain from a change to a test, or why a test wasn't selected.
- **Shadow mode:** `depwave shadow` checks every failure of a full test run against the selection, reading Vitest and
  Jest JSON and JUnit XML. Its JSON says what each verdict rests on: whether the run tested the selection, and whether
  every test file had a result.
- **Lockfiles:** pnpm, npm and Yarn Berry changes are narrowed to the packages whose resolved dependencies changed.
- **Changes no import expresses:** rules for configs, CI definitions, toolchain files, data files and snapshots, plus
  `[depwave:all]` in a commit message to select everything.
- **Other commands:** `depwave cycles` lints for import cycles, and `depwave graph` draws the dependency graph as
  Mermaid or Graphviz.
- **GitHub Action:** a job summary, a sticky pull request comment, a cached analysis, and a full run outside pull
  requests.
