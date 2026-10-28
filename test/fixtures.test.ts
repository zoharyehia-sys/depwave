/**
 * Validates the golden files themselves. Phase 1 adds the real golden test:
 * materialize repo/ into a temp git repo, commit, apply each scenario, commit, run `depwave impact`, compare.
 */
import { describe, expect, it } from 'vitest';
import { applyChanges, isTestFile, loadFixtures, symbolExpectation, type Expectation } from './support/fixtures.js';

const fixtures = await loadFixtures();

const sorted = (xs: readonly string[]) => [...xs].sort();

it('has the full fixture set', () => {
  expect(fixtures.map((f) => f.name)).toEqual(['barrel-hell', 'cycles', 'dynamic-imports', 'instance-methods', 'pnpm-basic', 'pnpm-lockfile', 'runtime-deps', 'ts-paths']);
});

describe.each(fixtures)('$name', ({ spec, files }) => {
  it('contains test files and uniquely named scenarios', () => {
    expect([...files.keys()].some(isTestFile)).toBe(true);
    const names = spec.scenarios.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('lists cycles that exist, sorted', () => {
    for (const cycle of spec.cycles ?? []) {
      expect(cycle).toEqual(sorted(cycle));
      for (const path of cycle) expect(files.has(path), path).toBe(true);
    }
  });

  describe.each(spec.scenarios)('scenario $name', (scenario) => {
    const after = applyChanges(files, scenario.changes);
    const testsAfter = new Set([...after.keys()].filter(isTestFile));

    const checkExpectation = (expectation: Expectation) => {
      const { impactedTests } = expectation;
      expect(impactedTests, 'sorted, so diffs of goldens stay readable').toEqual(sorted(impactedTests));
      expect(new Set(impactedTests).size).toBe(impactedTests.length);
      for (const test of impactedTests) expect(testsAfter.has(test), `${test} is a test file after the change`).toBe(true);
    };

    it('has valid file-level expectations', () => checkExpectation(scenario.expected.file));

    it('has valid symbol-level expectations that are a subset of file-level', () => {
      const symbol = symbolExpectation(scenario);
      checkExpectation(symbol);
      for (const test of symbol.impactedTests) expect(scenario.expected.file.impactedTests).toContain(test);
    });
  });
});
