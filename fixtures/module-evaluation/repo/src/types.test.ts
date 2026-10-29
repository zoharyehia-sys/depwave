import { expect, it } from 'vitest';
import type { Handler } from './setup';

it('only uses a type from setup, which is erased at runtime', () => {
  const handler: Handler = 'x';
  expect(handler).toBe('x');
});
