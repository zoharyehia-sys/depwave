import { expect, it } from 'vitest';
import { handlers } from './registry';
// Imported for what the class does while it's being defined. `Statics` itself is never used.
import { Statics } from './statics';

it('registers while the class is defined', () => {
  expect(handlers).toContain('static-block');
});
