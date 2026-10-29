import { expect, it } from 'vitest';
import { boot } from './boot';
import { handlers } from './registry';

it('boots, which loads setup', () => {
  expect(boot()).toBe('booted');
  expect(handlers).toContain('global');
});
