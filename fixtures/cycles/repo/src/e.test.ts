import { expect, it } from 'vitest';
import { e } from './e';

it('is independent', () => {
  expect(e()).toBe('independent');
});
