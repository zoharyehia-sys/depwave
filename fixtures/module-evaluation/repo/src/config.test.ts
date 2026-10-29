import { expect, it } from 'vitest';
import { pluginCount } from './config';
import { handlers } from './registry';

it('registers the logger plugin when config loads', () => {
  expect(pluginCount()).toBe(1);
  expect(handlers).toContain('logger');
});
