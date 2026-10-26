import { expect, it } from 'vitest';
import { loadPlugin } from './registry';

it('loads the logger plugin', async () => {
  expect(await loadPlugin('./builtin/logger.ts')).toHaveProperty('logger');
});
