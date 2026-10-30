# Changelog

depwave follows [Semantic Versioning](https://semver.org). Until 1.0, a minor version can change selection rules, the
CLI and the JSON output.

## 0.1.0-alpha.0 (unreleased)

First npm release. It's an alpha: run it in [shadow mode](README.md#shadow-mode) next to your full test suite, and don't
skip tests based on it yet.

- **Test selection:** `depwave impact` selects the test files a diff can reach, through a symbol-level graph of both
  revisions, at symbol or file granularity.
- **Explanations:** `depwave why` shows the path from a test to the change, or why a test wasn't selected.
- **Shadow mode:** `depwave shadow` checks every failure of a full test run against the selection. It reads Vitest and
  Jest JSON and JUnit XML.
- **Lockfiles:** pnpm, npm and Yarn Berry changes are narrowed to the packages whose resolved dependencies changed.
- **Changes no import expresses:** rules for configs, CI definitions, toolchain files, data files and snapshots, plus
  `[depwave:all]` in a commit message to select everything.
- **Other commands:** `depwave cycles` lints for import cycles, and `depwave graph` draws the dependency graph.
- **GitHub Action:** a job summary, a sticky pull request comment, a cached analysis, and a full run outside pull
  requests.
