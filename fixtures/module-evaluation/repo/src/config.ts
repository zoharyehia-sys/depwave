import { register } from './registry';

export const plugin = register('logger');

export function pluginCount(): number {
  return 1;
}
