import { expect, it } from 'vitest';
import { d } from './d';

it('calls into the cycle', () => {
  expect(d()).toBe(5);
});
