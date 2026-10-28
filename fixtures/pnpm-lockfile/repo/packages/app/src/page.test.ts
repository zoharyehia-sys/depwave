import { expect, it } from 'vitest';
import { renderPage } from './page';

it('renders a badge', () => expect(renderPage()).toContain('badge--active'));
