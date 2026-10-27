import { expect, it } from 'vitest';
import { unrelated } from './unrelated';

it('works', () => {
  expect(unrelated()).toBe(42);
});
