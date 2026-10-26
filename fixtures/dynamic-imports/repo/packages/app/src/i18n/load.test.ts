import { expect, it } from 'vitest';
import { loadMessages } from './load';

it('loads a locale', async () => {
  expect((await loadMessages('en')).hello).toBe('Hello');
});
