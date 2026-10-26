import { expect, it } from 'vitest';
import { renderSettings } from './settings';

it('renders', () => {
  expect(renderSettings()).toContain('theme');
});
