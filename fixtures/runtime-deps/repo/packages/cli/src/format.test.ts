import { expect, it } from 'vitest';
import { format } from './format';

it('formats', () => {
  expect(format(' My App ')).toMatchSnapshot();
});
