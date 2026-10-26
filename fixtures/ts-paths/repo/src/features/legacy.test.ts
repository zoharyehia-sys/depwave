import { expect, it } from 'vitest';
import { banner } from './legacy';

it('shows the version', () => {
  expect(banner()).toBe('legacy (utils.ts)');
});
