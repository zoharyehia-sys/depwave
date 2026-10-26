import { expect, it } from 'vitest';
import { Button } from './Button';

it('renders a button', () => {
  expect(Button('Go')).toContain('Go');
});
