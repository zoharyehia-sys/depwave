import { PriceTag } from '@basic/ui';

export function renderCheckout(total: number): string {
  return `<main>Total: ${PriceTag(total)}</main>`;
}
