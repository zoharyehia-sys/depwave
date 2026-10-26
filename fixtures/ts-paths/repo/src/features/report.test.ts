import { expect, it } from 'vitest';
import { reportTitle } from './report';

it('titles', () => {
  expect(reportTitle(new Date('2026-01-02'))).toBe('Report for 2026-01-02');
});
