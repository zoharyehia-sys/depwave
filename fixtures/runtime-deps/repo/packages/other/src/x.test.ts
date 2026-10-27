import { expect, it } from 'vitest';
import { other } from './x';

it('works', () => {
  expect(other()).toBe(1);
});
