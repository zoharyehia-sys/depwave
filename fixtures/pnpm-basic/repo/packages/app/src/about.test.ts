import { expect, it } from 'vitest';
import { renderAbout } from './about';

it('renders', () => {
  expect(renderAbout()).toContain('About');
});
