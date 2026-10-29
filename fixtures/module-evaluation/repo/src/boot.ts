// Loads setup (and so runs its top-level code) without using anything from it.
import { helper } from './setup';

export function boot(): string {
  return 'booted';
}
