import { expect, it } from 'vitest';
import { slugify } from './strings';

it('slugifies', () => {
  expect(slugify('Hello World')).toBe('hello-world');
});
