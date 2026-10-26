import { a } from './a';

export function c(n: number): number {
  return n <= 0 ? 0 : a(n - 1) + 1;
}
