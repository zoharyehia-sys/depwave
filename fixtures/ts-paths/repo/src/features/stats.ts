import { mean } from '~/lib/math';

export function summary(values: number[]): string {
  return `avg=${mean(values).toFixed(2)}`;
}
