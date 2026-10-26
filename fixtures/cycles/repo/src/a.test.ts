import { expect, it } from 'vitest';
import { a } from './a';

it('recurses through the cycle', () => {
  expect(a(3)).toBe(3);
});
