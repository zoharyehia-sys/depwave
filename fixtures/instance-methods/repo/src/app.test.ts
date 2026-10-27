import { expect, it } from 'vitest';
import { main } from './app';

it('reports the error message', () => {
  expect(() => main('')).toThrow('service failed: empty command');
});
