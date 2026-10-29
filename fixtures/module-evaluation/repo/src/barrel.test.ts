import { expect, it } from 'vitest';
import { a } from './lib';
import { handlers } from './registry';

it('loading the barrel loads b too', () => {
  expect(a()).toBe('a');
  expect(handlers).toContain('b');
});
