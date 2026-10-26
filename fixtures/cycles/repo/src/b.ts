import { c } from './c';

export function b(n: number): number {
  return n <= 0 ? 0 : c(n - 1) + 1;
}
