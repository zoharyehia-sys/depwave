import { expect, it } from 'vitest';
import { PriceTag } from './PriceTag';

it('wraps the price', () => {
  expect(PriceTag(5)).toContain('$5.00');
});
