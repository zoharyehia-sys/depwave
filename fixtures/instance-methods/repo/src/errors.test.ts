import { expect, it } from 'vitest';
import { AppError } from './errors';

it('formats', () => {
  expect(new AppError('x').message).toBe('service failed: x');
});
