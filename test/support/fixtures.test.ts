import { describe, expect, it } from 'vitest';
import { applyChanges, isTestFile } from './fixtures.js';

const tree = new Map([
  ['src/a.ts', 'export const a = 1;\n'],
  ['src/b.ts', 'export const b = a + a;\n'],
]);

describe('applyChanges', () => {
  it('applies modify, add, delete and rename without touching the input', () => {
    const next = applyChanges(tree, [
      { op: 'modify', path: 'src/a.ts', find: '= 1', replace: '= 2' },
      { op: 'add', path: 'src/c.ts', content: 'c' },
      { op: 'rename', path: 'src/c.ts', to: 'src/d.ts' },
      { op: 'delete', path: 'src/b.ts' },
    ]);
    expect(Object.fromEntries(next)).toEqual({ 'src/a.ts': 'export const a = 2;\n', 'src/d.ts': 'c' });
    expect(tree.get('src/a.ts')).toBe('export const a = 1;\n');
  });

  it('treats replacement text literally (no $& expansion)', () => {
    const next = applyChanges(tree, [{ op: 'modify', path: 'src/a.ts', find: '1', replace: '$&$&' }]);
    expect(next.get('src/a.ts')).toBe('export const a = $&$&;\n');
  });

  it.each([
    [{ op: 'modify', path: 'src/b.ts', find: 'a', replace: 'x' }, /occurs 2 times/],
    [{ op: 'modify', path: 'src/a.ts', find: 'zzz', replace: 'x' }, /occurs 0 times/],
    [{ op: 'modify', path: 'src/a.ts', find: '1', replace: '1' }, /no-op/],
    [{ op: 'modify', path: 'nope.ts', find: 'a', replace: 'b' }, /does not exist/],
    [{ op: 'add', path: 'src/a.ts', content: '' }, /already exists/],
    [{ op: 'delete', path: 'nope.ts' }, /does not exist/],
    [{ op: 'rename', path: 'src/a.ts', to: 'src/b.ts' }, /already exists/],
  ] as const)('rejects %o', (change, error) => {
    expect(() => applyChanges(tree, [change])).toThrow(error);
  });
});

describe('isTestFile', () => {
  it.each(['a.test.ts', 'src/a.spec.tsx', 'a.test.mjs', 'a.test.js'])('%s is a test', (p) => expect(isTestFile(p)).toBe(true));
  it.each(['a.ts', 'test-utils.ts', 'src/testing/a.ts', 'a.test.ts.snap'])('%s is not a test', (p) =>
    expect(isTestFile(p)).toBe(false),
  );
});
