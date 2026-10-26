import { formatCurrency } from '@basic/utils';

export function PriceTag(amount: number): string {
  return `<span class="price">${formatCurrency(amount)}</span>`;
}
