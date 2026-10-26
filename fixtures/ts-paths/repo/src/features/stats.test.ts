import { expect, it } from 'vitest';
import { summary } from './stats';

it('averages', () => {
  expect(summary([1, 2])).toBe('avg=1.50');
});
