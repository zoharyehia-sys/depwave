import type { LanguageAdapter } from '@depwave/core';
import { describe, expect, it } from 'vitest';
import { LanguageRegistry } from './LanguageRegistry.js';

const fakeAdapter = (id: LanguageAdapter['id'], extensions: string[]): LanguageAdapter => ({
  id,
  extensions,
  extractFacts: () => {
    throw new Error('unused');
  },
  isTestFile: () => false,
});

describe('LanguageRegistry', () => {
  const registry = new LanguageRegistry()
    .register(fakeAdapter('typescript', ['.ts', '.mts', '.cts']))
    .register(fakeAdapter('tsx', ['.tsx']));

  it('picks the adapter by extension, case-insensitively', () => {
    expect(registry.languageOf('src/a.ts')).toBe('typescript');
    expect(registry.languageOf('src/App.TSX')).toBe('tsx');
    expect(registry.languageOf('src/a.d.mts')).toBe('typescript');
  });

  it('returns undefined for unknown or missing extensions', () => {
    expect(registry.languageOf('README.md')).toBeUndefined();
    expect(registry.languageOf('Makefile')).toBeUndefined();
  });

  it('rejects two adapters claiming the same extension', () => {
    expect(() => new LanguageRegistry().register(fakeAdapter('typescript', ['.ts'])).register(fakeAdapter('javascript', ['.ts']))).toThrow(
      /already handled by typescript/,
    );
  });
});
