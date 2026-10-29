import { register } from '../registry';

register('b');

export function b(): string {
  return 'b';
}
