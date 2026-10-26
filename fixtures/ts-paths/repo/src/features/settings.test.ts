import { expect, it } from 'vitest';
import { settingsSource } from './settings';

it('reads config', () => {
  expect(settingsSource()).toBe('config/index.ts');
});
