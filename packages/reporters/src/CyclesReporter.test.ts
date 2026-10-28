import { describe, expect, it } from 'vitest';
import { renderCyclesText } from './CyclesReporter.js';

const rev = '0123456789abcdef0123456789abcdef01234567';

describe('renderCyclesText', () => {
  it('says so when there are none, and which imports it followed', () => {
    expect(renderCyclesText([], { rev, unresolved: 0, includeTypeOnly: false })).toBe('depwave cycles 0123456789ab: no import cycles ✔ (runtime imports)\n');
  });

  it('numbers each loop, and flags a component larger than its shortest loop', () => {
    const text = renderCyclesText(
      [
        { files: ['a.ts', 'b.ts'], loop: ['a.ts', 'b.ts', 'a.ts'] },
        { files: ['x.ts', 'y.ts', 'z.ts'], loop: ['x.ts', 'y.ts', 'x.ts'] },
      ],
      { rev: 'WORKTREE', unresolved: 0, includeTypeOnly: true },
    );
    expect(text).toBe(
      [
        'depwave cycles WORKTREE: 2 import cycles ✘ (imports, including type-only ones)',
        '  1. a.ts → b.ts → a.ts',
        '  2. x.ts → y.ts → x.ts   (shortest loop; 3 files depend on each other)',
        '',
      ].join('\n'),
    );
  });

  it('warns that unresolved imports can hide cycles', () => {
    expect(renderCyclesText([], { rev, unresolved: 2, includeTypeOnly: false })).toContain("⚠ 2 unresolved imports: a cycle through one of them isn't visible");
  });
});
