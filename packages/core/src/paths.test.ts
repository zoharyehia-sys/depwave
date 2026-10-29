import { describe, expect, it } from 'vitest';
import { isTestPath } from './paths.js';

describe('isTestPath (the default convention, Jest\'s testMatch)', () => {
  it.each([
    ['src/a.test.ts', true],
    ['src/a.spec.mjs', true],
    ['src/a.test.tsx', true],
    ['src/__tests__/helper.ts', true], // Jest runs every JS/TS file under __tests__
    ['src/__tests__/deep/b.js', true],
    ['src/a.ts', false],
    ['src/a.test.py', false],
    // Data under __tests__ is never a test: it gets no result in a full run, so it would make shadow mode inconclusive.
    ['src/__tests__/fixtures/data.json', false],
    ['src/__tests__/__snapshots__/a.test.ts.snap', false],
  ])('%s → %s', (path, expected) => {
    expect(isTestPath(path)).toBe(expected);
  });
});
