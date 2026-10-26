// Resolves to src/utils.ts: a file beats a directory index for the same specifier.
import { VERSION } from '../utils';

export function banner(): string {
  return `legacy (${VERSION})`;
}
