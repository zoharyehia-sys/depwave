import { describe, expect, it } from 'vitest';
import { nodeId, parseNodeId, toPosixPath } from './ids.js';

describe('toPosixPath', () => {
  it.each([
    ['packages\\ui\\src\\Button.ts', 'packages/ui/src/Button.ts'],
    ['./src/a.ts', 'src/a.ts'],
    ['././src//a.ts', 'src/a.ts'],
    ['src/utils/', 'src/utils'],
    ['src/a.ts', 'src/a.ts'],
  ])('%s → %s', (input, expected) => {
    expect(toPosixPath(input)).toBe(expected);
  });
});

describe('nodeId', () => {
  it('normalizes Windows paths so ids are identical on every OS', () => {
    expect(nodeId.file('packages\\ui\\src\\Button.ts')).toBe(nodeId.file('packages/ui/src/Button.ts'));
  });

  it('builds symbol ids with a member', () => {
    expect(nodeId.symbol('src/money.ts', 'formatCurrency')).toBe('sym:src/money.ts#formatCurrency');
  });

  it('builds test ids with and without a test name', () => {
    expect(nodeId.test('src/a.test.ts')).toBe('test:src/a.test.ts');
    expect(nodeId.test('src/a.test.ts', 'adds numbers')).toBe('test:src/a.test.ts#adds numbers');
  });
});

describe('parseNodeId', () => {
  it('round-trips every kind', () => {
    expect(parseNodeId(nodeId.package('@acme/ui'))).toEqual({ kind: 'package', target: '@acme/ui' });
    expect(parseNodeId(nodeId.file('src/a.ts'))).toEqual({ kind: 'file', target: 'src/a.ts' });
    expect(parseNodeId(nodeId.symbol('src/a.ts', 'Cls.method'))).toEqual({
      kind: 'symbol',
      target: 'src/a.ts',
      member: 'Cls.method',
    });
    expect(parseNodeId(nodeId.external('react@18.3.1'))).toEqual({ kind: 'external', target: 'react@18.3.1' });
    expect(parseNodeId(nodeId.unresolved('src/r.ts', 'import(name)'))).toEqual({
      kind: 'unresolved',
      target: 'src/r.ts',
      member: 'import(name)',
    });
  });

  it('does not split package names on #', () => {
    expect(parseNodeId('pkg:weird#name')).toEqual({ kind: 'package', target: 'weird#name' });
  });

  it('rejects unknown prefixes', () => {
    expect(() => parseNodeId('nope:x')).toThrow(/Invalid node id/);
    expect(() => parseNodeId('no-colon')).toThrow(/Invalid node id/);
  });
});
