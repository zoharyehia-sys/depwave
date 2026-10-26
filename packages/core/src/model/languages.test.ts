import { describe, expect, it } from 'vitest';
import { languageFromPath } from './languages.js';

describe('languageFromPath', () => {
  it.each([
    ['src/a.ts', 'typescript'],
    ['src/types.d.ts', 'typescript'],
    ['src/a.mts', 'typescript'],
    ['src/App.tsx', 'tsx'],
    ['src/App.TSX', 'tsx'],
    ['bin/cli.cjs', 'javascript'],
    ['src/Old.jsx', 'jsx'],
    ['tools/gen.py', 'python'],
  ])('%s → %s', (path, language) => {
    expect(languageFromPath(path)).toBe(language);
  });

  it.each(['README.md', 'package.json', 'Makefile', '.eslintrc', 'src/.ts', 'v1.2/LICENSE'])('%s → undefined', (path) => {
    expect(languageFromPath(path)).toBeUndefined();
  });
});
