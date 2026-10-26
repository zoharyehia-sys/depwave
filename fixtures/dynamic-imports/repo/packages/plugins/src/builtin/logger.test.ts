import { expect, it } from 'vitest';
import { logger } from './logger';

it('logs', () => {
  expect(() => logger('hi')).not.toThrow();
});
