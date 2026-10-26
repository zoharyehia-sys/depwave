import { expect, it } from 'vitest';
import { renderDialog } from './dialog';

it('renders', () => {
  expect(renderDialog('hi')).toContain('<p>hi</p>');
});
