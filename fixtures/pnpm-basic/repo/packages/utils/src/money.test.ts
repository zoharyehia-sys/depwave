import { expect, it } from 'vitest';
import { formatCurrency } from './money';

it('formats USD', () => {
  expect(formatCurrency(5)).toBe('$5.00');
});
