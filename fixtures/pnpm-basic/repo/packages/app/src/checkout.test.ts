import { expect, it } from 'vitest';
import { renderCheckout } from './checkout';

it('renders the total', () => {
  expect(renderCheckout(5)).toContain('Total:');
});
