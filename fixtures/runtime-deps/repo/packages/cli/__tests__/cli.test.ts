import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

// Runs the CLI as a process: no import connects this test to the code it exercises.
it('runs', () => {
  const out = execFileSync('node', [new URL('../src/index.ts', import.meta.url).pathname, 'demo'], { encoding: 'utf8' });
  expect(out).toBe('');
});
