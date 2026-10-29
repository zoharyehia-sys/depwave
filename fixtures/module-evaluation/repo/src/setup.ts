import { register } from './registry';

register('global');

export type Handler = string;

export function helper(): string {
  return 'help';
}
