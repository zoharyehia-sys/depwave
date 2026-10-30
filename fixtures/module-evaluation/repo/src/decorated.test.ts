import { expect, it } from 'vitest';
// Imported for what its decorators do. `Decorated` itself is never used.
import { Decorated } from './decorated';
import { handlers } from './registry';

it('runs the decorators when the class is defined', () => {
  expect(handlers).toContain('decorated');
});
