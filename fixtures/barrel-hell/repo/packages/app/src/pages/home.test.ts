import { expect, it } from 'vitest';
import { renderHome } from './home';

it('renders', () => {
  expect(renderHome()).toContain('Welcome');
});
