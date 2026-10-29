import { expect, it } from 'vitest';
import { handlers } from './registry';
// Imported for its side effect: loading setup registers the global handler. `helper` itself is never used.
import { helper } from './setup';

it('sees the handler that loading setup registers', () => {
  expect(handlers).toContain('global');
});
